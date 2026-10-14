#!/bin/bash
# render-check.sh — render the chart and assert the critical wiring.
# Usage: ./ci/render-check.sh
set -euo pipefail
cd "$(dirname "$0")/.."
helm dependency update >/dev/null
helm template agentgateway-stack . -n ping-devops-fcarbone > /tmp/ag-stack-render-check.yaml
python3 - <<'EOF'
import yaml
docs = list(yaml.safe_load_all(open('/tmp/ag-stack-render-check.yaml')))
def find(kind, name):
    return next((d for d in docs if d and d.get('kind') == kind and d['metadata']['name'] == name), None)

# workloads + services (keyed by kind+name: Deployment/Service/ConfigMap share names)
for kind, n in [('Deployment','agentgateway-stack-adapter'),('Deployment','agentgateway-stack-agentgateway'),
                ('Deployment','agentgateway-stack-demo-mcp'),
                ('StatefulSet','agentgateway-stack-pingauthorize'),('StatefulSet','agentgateway-stack-pingauthorizepap'),
                ('StatefulSet','agentgateway-stack-pingdirectory'),
                ('Service','agentgateway-stack-agentgateway'),('Service','agentgateway-stack-adapter'),
                ('Service','agentgateway-stack-demo-mcp'),('Service','agentgateway-stack-pingauthorizepap')]:
    assert find(kind, n), f'missing {kind}/{n}'

# AG config points at cluster DNS
cfg = find('ConfigMap','agentgateway-stack-agentgateway-config')['data']['agentgateway.yaml']
assert 'agentgateway-stack-demo-mcp:3000/mcp/portfolio' in cfg
assert 'agentgateway-stack-adapter:8082' in cfg
assert 'x-client-host: agentgateway-stack-ag.ping-devops.com' in cfg

# sideband secret shared by PAZ and adapter
sec = find('Secret','agentgateway-stack-sideband')
assert 'SECRET_HEADER_VALUE' in sec['stringData']
paz_envs = find('StatefulSet','agentgateway-stack-pingauthorize')['spec']['template']['spec']['containers'][0]['env']
assert any(e.get('name')=='SIDEBAND_SHARED_SECRET' and e['valueFrom']['secretKeyRef']['name']=='agentgateway-stack-sideband' for e in paz_envs)
ad_envs = find('Deployment','agentgateway-stack-adapter')['spec']['template']['spec']['containers'][0]['env']
assert any(e.get('name')=='SECRET_HEADER_VALUE' and e['valueFrom']['secretKeyRef']['name']=='agentgateway-stack-sideband' for e in ad_envs)

# no admin port in any Service (loopback-only per agentgateway docs)
for d in docs:
    if d and d.get('kind')=='Service':
        assert all(p['port'] != 15000 for p in d['spec']['ports']), f"admin port in Service {d['metadata']['name']}"

# ingress + certificates: exactly our two public hosts, SSE annotations on AG;
# certificates = 2 public (letsencrypt) + 3 internal private-certs (selfsigned)
ag_ing = find('Ingress','agentgateway-stack-agentgateway')
assert ag_ing['metadata']['annotations']['nginx.ingress.kubernetes.io/proxy-buffering']=='off'
assert len([d for d in docs if d and d.get('kind')=='Ingress'])==2
certs = [d for d in docs if d and d.get('kind')=='Certificate']
lets = [c for c in certs if c['spec']['issuerRef']['name']=='letsencrypt-pdo']
priv = [c for c in certs if c['spec']['issuerRef']['name'].endswith('-internal-ca')]
assert len(lets)==2 and len(priv)==3, (len(lets), len(priv))

# PAP import hook word-splits filenames — the shipped snapshot must not contain
# spaces (a space turns one import into three and every one fails)
import os, glob
snaps = glob.glob('../../server-profiles/pingauthorizepap/policies/*.SNAPSHOT')
assert snaps, 'no policy snapshot in server-profiles'
for s in snaps:
    assert ' ' not in os.path.basename(s), f'snapshot filename has spaces: {s}'

print('render-check OK')
EOF
