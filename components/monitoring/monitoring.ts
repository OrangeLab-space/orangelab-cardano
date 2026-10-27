import * as kubernetes from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { config, GrafanaDashboard } from '@orangelab/pulumi';
import dashboardJson from './grafana-dashboard.json';
import { Cardano } from '../cardano/cardano';
import { MidnightNode } from '../midnight-node/midnight-node';

export interface MonitoringArgs {
    cardano: Cardano;
    midnightNode?: MidnightNode;
}

/**
 * Prometheus ServiceMonitors, alert rules, and Grafana dashboard for the stack.
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

        new GrafanaDashboard(
            `${name}-dashboard`,
            { configJson: dashboardJson },
            { parent: this },
        );
    }
}
