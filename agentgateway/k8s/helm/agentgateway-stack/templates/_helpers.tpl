{{/* Release-scoped resource names, matching the Ping chart's <release>-<product> convention. */}}
{{- define "ag-stack.adapterName" -}} {{ .Release.Name }}-adapter {{- end }}
{{- define "ag-stack.agentgatewayName" -}} {{ .Release.Name }}-agentgateway {{- end }}
{{- define "ag-stack.demoMcpName" -}} {{ .Release.Name }}-demo-mcp {{- end }}
{{- define "ag-stack.pazService" -}} {{ .Release.Name }}-pingauthorize {{- end }}
{{- define "ag-stack.papService" -}} {{ .Release.Name }}-pingauthorizepap {{- end }}
{{- define "ag-stack.sidebandSecret" -}} {{ .Release.Name }}-sideband {{- end }}
