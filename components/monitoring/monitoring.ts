import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { config } from '@orangelab/pulumi';
import dashboardJson from './grafana-dashboard.json';
import { Cardano } from '../cardano/cardano';
import { MidnightNode } from '../midnight-node/midnight-node';

export interface MonitoringArgs {
    cardano: Cardano;
    midnightNode?: MidnightNode;
}

/**
 * Create a fixed-name dashboard ConfigMap. deleteBeforeReplace keeps the
 * ConfigMap name stable; the Grafana sidecar reloads it after replacement.
 */
function createDashboard(
    parent: pulumi.ComponentResource,
    name: string,
    configJson: unknown,
): void {
    new kubernetes.core.v1.ConfigMap(
        `${name}-dashboard`,
        {
            metadata: {
                name: `${name}-dashboard`,
                labels: {
                    grafana_dashboard: '1',
                },
                annotations: {
                    'k8s-sidecar-target-folder': 'OrangeLab',
                },
            },
            data: {
                [`${name}.json`]: JSON.stringify(configJson).replace(
                    /\${DS_PROMETHEUS}/g,
                    'Prometheus',
                ),
            },
        },
        { parent, deleteBeforeReplace: true },
    );
}

/**
 * Prometheus ServiceMonitors, alert rules, and Grafana dashboards for the stack.
 *
 * The ServiceMonitor and PrometheusRule manifests live in this component folder
 * so the same files can be reviewed or applied manually without reading Pulumi
 * code.
 */
export class Monitoring extends pulumi.ComponentResource {
    constructor(name: string, args: MonitoringArgs, opts?: pulumi.ResourceOptions) {
        super('orangelab:cardano:Monitoring', name, args, opts);
        if (!config.enableMonitoring()) return;

        new kubernetes.yaml.ConfigFile(
            `${name}-cardano-service-monitor`,
            { file: 'components/monitoring/servicemonitor-cardano.yaml' },
            { parent: this, dependsOn: [args.cardano] },
        );
        new kubernetes.yaml.ConfigFile(
            `${name}-db-sync-pod-monitor`,
            { file: 'components/monitoring/podmonitor-cardano-db-sync.yaml' },
            { parent: this, dependsOn: [args.cardano] },
        );
        new kubernetes.yaml.ConfigFile(
            `${name}-alerts`,
            { file: 'components/monitoring/prometheus-rules.yaml' },
            { parent: this, dependsOn: [args.cardano] },
        );

        if (args.midnightNode) {
            new kubernetes.yaml.ConfigFile(
                `${name}-midnight-service-monitor`,
                { file: 'components/monitoring/servicemonitor-midnight-node.yaml' },
                { parent: this, dependsOn: [args.midnightNode] },
            );
        }

        createDashboard(this, `${name}-dashboard`, dashboardJson);
    }
}
