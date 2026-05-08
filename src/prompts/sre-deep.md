# Alert Event Deep Analysis

You are a senior SRE engineer. Please perform a deep analysis based on the following alert data.

## Alert Data

{{data}}

{{context}}

## Analysis Requirements

Please output the analysis results in the following structure:

### 1. Event Summary
Briefly describe the core issue of the alert event (one or two sentences).

### 2. Root Cause Analysis
Based on log and trace data, analyze possible root causes. Focus on:
- Anomaly patterns and high-frequency errors in error logs
- Abnormal calls in traces (high error rates, abnormal latency)
- Dependency relationships between services and fault propagation paths
- Causal relationships along the timeline

### 3. Impact Scope
Assess the business impact of the issue:
- Affected services/APIs
- Estimated number of affected users or requests
- Duration of the issue

### 4. Remediation Recommendations
Provide specific handling recommendations:
- Short-term mitigation measures
- Long-term optimization suggestions
- Monitoring metrics or investigation directions to watch
