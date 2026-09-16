'use strict';

const { expect } = require('chai');
const proxyquire = require('proxyquire');

function stubExecutor(result) {
  return { run: () => Promise.resolve(result) };
}

describe('kubectl', () => {
  describe('getPods', () => {
    it('passes the target through as separate arguments', async () => {
      const calls = [];
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': {
          run: (bin, args) => {
            calls.push({ bin, args });
            return Promise.resolve({ stdout: '{"items":[]}', stderr: '', code: 0 });
          },
        },
      });

      await kubectl.getPods({ context: 'ctx-stg', namespace: 'ns-stg' });

      expect(calls[0].bin).to.equal('kubectl');
      expect(calls[0].args).to.include.members([
        'get',
        'pods',
        '--context',
        'ctx-stg',
        '--namespace',
        'ns-stg',
      ]);
    });

    it('returns parsed rows on success', async () => {
      const payload = {
        items: [
          {
            metadata: { name: 'pod-a', creationTimestamp: new Date().toISOString() },
            spec: { nodeName: 'node-1' },
            status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: {} }] },
          },
        ],
      };
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': stubExecutor({ stdout: JSON.stringify(payload), stderr: '', code: 0 }),
      });

      const result = await kubectl.getPods({ context: 'c', namespace: 'n' });

      expect(result.pods).to.have.lengthOf(1);
      expect(result.pods[0].name).to.equal('pod-a');
    });

    it('applies the target timeout to kubectl and the executor', async () => {
      const calls = [];
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': {
          run: (bin, args, options) => {
            calls.push({ args, options });
            return Promise.resolve({ stdout: '{"items":[]}', stderr: '', code: 0 });
          },
        },
      });

      await kubectl.getPods({ context: 'c', namespace: 'n', timeoutSeconds: 45 });

      expect(calls[0].args).to.include('--request-timeout=45s');
      // The executor waits a little longer, so kubectl reports the timeout
      // itself rather than being killed first.
      expect(calls[0].options.timeout).to.be.above(45000);
    });

    it('classifies a non-zero exit instead of throwing', async () => {
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': stubExecutor({
          stdout: '',
          stderr: 'Unable to connect to the server: dial tcp: i/o timeout',
          code: 1,
        }),
      });

      const result = await kubectl.getPods({ context: 'c', namespace: 'n' });

      expect(result.error.kind).to.equal('network');
      expect(result.pods).to.equal(undefined);
    });
  });

  describe('rolloutRestart', () => {
    it('targets the deployment, not the pod', async () => {
      const calls = [];
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': {
          run: (bin, args) => {
            calls.push(args);
            return Promise.resolve({
              stdout: 'deployment.apps/athenaapp-deployment restarted',
              stderr: '',
              code: 0,
            });
          },
        },
      });

      const result = await kubectl.rolloutRestart(
        { context: 'c', namespace: 'n', timeoutSeconds: 30 },
        'athenaapp-deployment'
      );

      expect(calls[0]).to.include.members([
        'rollout',
        'restart',
        'deployment/athenaapp-deployment',
      ]);
      expect(result.message).to.equal('deployment.apps/athenaapp-deployment restarted');
    });

    it('classifies a failure rather than throwing', async () => {
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': stubExecutor({
          stdout: '',
          stderr: 'Error from server (Forbidden): deployments.apps is forbidden',
          code: 1,
        }),
      });

      const result = await kubectl.rolloutRestart({ context: 'c', namespace: 'n' }, 'dep');

      expect(result.error.kind).to.equal('rbac');
    });
  });

  describe('buildScalePatch', () => {
    const kubectl = require('../lib/k8s/kubectl');

    const autoscaler = {
      name: 'athenaapp-scaledobject',
      min: 2,
      max: 6,
      triggers: [
        { type: 'cron', metadata: { desiredReplicas: '4', timezone: 'Asia/Jakarta' } },
        { type: 'prometheus', metadata: { threshold: '10' } },
      ],
    };

    it('pins min and max to the requested count', () => {
      const patch = kubectl.buildScalePatch(autoscaler, 3);

      expect(patch.spec.minReplicaCount).to.equal(3);
      expect(patch.spec.maxReplicaCount).to.equal(3);
    });

    it('moves cron desiredReplicas, as a string', () => {
      const patch = kubectl.buildScalePatch(autoscaler, 3);

      expect(patch.spec.triggers[0].metadata.desiredReplicas).to.equal('3');
    });

    it('leaves non-cron triggers untouched', () => {
      const patch = kubectl.buildScalePatch(autoscaler, 3);

      expect(patch.spec.triggers[1]).to.deep.equal(autoscaler.triggers[1]);
    });

    it('preserves other cron metadata', () => {
      const patch = kubectl.buildScalePatch(autoscaler, 3);

      expect(patch.spec.triggers[0].metadata.timezone).to.equal('Asia/Jakarta');
    });
  });

  describe('scaleDeployment', () => {
    it('scales directly when there is no autoscaler', async () => {
      const calls = [];
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': {
          run: (bin, args) => {
            calls.push(args);
            return Promise.resolve({ stdout: 'scaled', stderr: '', code: 0 });
          },
        },
      });

      await kubectl.scaleDeployment({ context: 'c', namespace: 'n' }, 'dep', 2);

      expect(calls).to.have.lengthOf(1);
      expect(calls[0]).to.include.members(['scale', '--replicas=2', 'deployment/dep']);
    });

    it('patches the ScaledObject before scaling', async () => {
      const calls = [];
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': {
          run: (bin, args) => {
            calls.push(args[0]);
            return Promise.resolve({ stdout: 'ok', stderr: '', code: 0 });
          },
        },
      });

      await kubectl.scaleDeployment({ context: 'c', namespace: 'n' }, 'dep', 2, {
        name: 'dep-scaledobject',
        triggers: [],
      });

      expect(calls).to.deep.equal(['patch', 'scale']);
    });

    it('stops if the patch fails, without scaling', async () => {
      const calls = [];
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': {
          run: (bin, args) => {
            calls.push(args[0]);
            return Promise.resolve({
              stdout: '',
              stderr: 'Error from server (Forbidden): scaledobjects is forbidden',
              code: 1,
            });
          },
        },
      });

      const result = await kubectl.scaleDeployment({ context: 'c', namespace: 'n' }, 'dep', 2, {
        name: 'dep-scaledobject',
        triggers: [],
      });

      expect(calls).to.deep.equal(['patch']);
      expect(result.error.kind).to.equal('rbac');
    });
  });

  describe('getScaledObjects', () => {
    it('returns an empty map when the CRD is missing', async () => {
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': stubExecutor({
          stdout: '',
          stderr: 'error: the server doesn\'t have a resource type "scaledobject"',
          code: 1,
        }),
      });

      expect(await kubectl.getScaledObjects({ context: 'c', namespace: 'n' })).to.deep.equal({});
    });

    it('keys entries by the deployment they target', async () => {
      const payload = {
        items: [{
          metadata: { name: 'athenaapp-scaledobject' },
          spec: {
            scaleTargetRef: { kind: 'Deployment', name: 'athenaapp-deployment' },
            minReplicaCount: 2,
            maxReplicaCount: 6,
            triggers: [],
          },
        }],
      };
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': stubExecutor({ stdout: JSON.stringify(payload), stderr: '', code: 0 }),
      });

      const map = await kubectl.getScaledObjects({ context: 'c', namespace: 'n' });

      expect(map['athenaapp-deployment'].name).to.equal('athenaapp-scaledobject');
      expect(map['athenaapp-deployment'].max).to.equal(6);
    });
  });

  describe('buildResourceFlags', () => {
    const kubectl = require('../lib/k8s/kubectl');

    it('renders cpu before memory, on one flag per kind', () => {
      const built = kubectl.buildResourceFlags({
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '2', memory: '1Gi' },
      });

      expect(built.flags).to.deep.equal([
        '--requests=cpu=100m,memory=128Mi',
        '--limits=cpu=2,memory=1Gi',
      ]);
    });

    it('omits a kind that contributes nothing', () => {
      const built = kubectl.buildResourceFlags({ requests: { cpu: '500m' } });

      expect(built.flags).to.deep.equal(['--requests=cpu=500m']);
    });

    it('omits a field that contributes nothing', () => {
      const built = kubectl.buildResourceFlags({ limits: { memory: '512M' } });

      expect(built.flags).to.deep.equal(['--limits=memory=512M']);
    });

    it('treats a blank form field as absent', () => {
      const built = kubectl.buildResourceFlags({
        requests: { cpu: '100m', memory: '' },
        limits: { cpu: null, memory: undefined },
      });

      expect(built.flags).to.deep.equal(['--requests=cpu=100m']);
    });

    it('rejects a request that is entirely empty', () => {
      const built = kubectl.buildResourceFlags({ requests: {}, limits: {} });

      expect(built.flags).to.equal(undefined);
      expect(built.error.kind).to.equal('invalid');
    });

    it('rejects a missing resources object', () => {
      expect(kubectl.buildResourceFlags().error.kind).to.equal('invalid');
    });

    it('accepts the cpu forms kubernetes uses', () => {
      ['100m', '0.5', '2', '1.25'].forEach((cpu) => {
        expect(kubectl.buildResourceFlags({ requests: { cpu } }).flags).to.deep.equal([
          `--requests=cpu=${cpu}`,
        ]);
      });
    });

    it('accepts the memory forms kubernetes uses', () => {
      ['128Mi', '1Gi', '512M', '2G', '1024', '1.5Gi'].forEach((memory) => {
        expect(kubectl.buildResourceFlags({ limits: { memory } }).flags).to.deep.equal([
          `--limits=memory=${memory}`,
        ]);
      });
    });

    it('rejects a cpu value that would be read as a flag', () => {
      const built = kubectl.buildResourceFlags({ requests: { cpu: '-1' } });

      expect(built.error.message).to.contain('requests.cpu');
    });

    it('rejects a memory value that would be read as a flag', () => {
      const built = kubectl.buildResourceFlags({ limits: { memory: '--foo' } });

      expect(built.error.message).to.contain('limits.memory');
    });

    it('rejects a unit kubernetes does not know', () => {
      expect(kubectl.buildResourceFlags({ limits: { memory: '128MB' } }).error.kind).to.equal(
        'invalid'
      );
    });

    it('rejects a cpu suffix other than m', () => {
      expect(kubectl.buildResourceFlags({ requests: { cpu: '100n' } }).error.kind).to.equal(
        'invalid'
      );
    });

    it('rejects an injected second value', () => {
      expect(
        kubectl.buildResourceFlags({ requests: { cpu: '100m,memory=64Gi' } }).error.kind
      ).to.equal('invalid');
    });

    it('names the first offending field', () => {
      const built = kubectl.buildResourceFlags({
        requests: { cpu: 'lots', memory: 'plenty' },
      });

      expect(built.error.message).to.contain('requests.cpu');
    });
  });

  describe('setResources', () => {
    function stubbedKubectl(calls, result) {
      return proxyquire('../lib/k8s/kubectl', {
        '../core/executor': {
          run: (bin, args, options) => {
            calls.push({ bin, args, options });
            return Promise.resolve(result);
          },
        },
      });
    }

    it('builds the full command as separate arguments', async () => {
      const calls = [];
      const kubectl = stubbedKubectl(calls, { stdout: 'deployment.apps/dep resource requirements updated', stderr: '', code: 0 });

      const result = await kubectl.setResources(
        { context: 'ctx-stg', namespace: 'ns-stg', timeoutSeconds: 30 },
        'athenaapp-deployment',
        { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '1Gi' } },
        'athenaapp'
      );

      expect(calls[0].bin).to.equal('kubectl');
      expect(calls[0].args).to.deep.equal([
        'set',
        'resources',
        'deployment/athenaapp-deployment',
        '--requests=cpu=100m,memory=128Mi',
        '--limits=cpu=1,memory=1Gi',
        '-c',
        'athenaapp',
        '--context',
        'ctx-stg',
        '--namespace',
        'ns-stg',
        '--request-timeout=30s',
      ]);
      expect(result.message).to.equal('deployment.apps/dep resource requirements updated');
    });

    it('leaves out -c when no container is named', async () => {
      const calls = [];
      const kubectl = stubbedKubectl(calls, { stdout: '', stderr: '', code: 0 });

      await kubectl.setResources({ context: 'c', namespace: 'n' }, 'dep', {
        requests: { cpu: '100m' },
      });

      expect(calls[0].args).to.not.include('-c');
    });

    it('sends only the flag the caller filled in', async () => {
      const calls = [];
      const kubectl = stubbedKubectl(calls, { stdout: '', stderr: '', code: 0 });

      await kubectl.setResources({ context: 'c', namespace: 'n' }, 'dep', {
        limits: { memory: '2Gi' },
      });

      expect(calls[0].args).to.include('--limits=memory=2Gi');
      expect(calls[0].args.join(' ')).to.not.contain('--requests');
    });

    it('applies the target timeout to kubectl and the executor', async () => {
      const calls = [];
      const kubectl = stubbedKubectl(calls, { stdout: '', stderr: '', code: 0 });

      await kubectl.setResources(
        { context: 'c', namespace: 'n', timeoutSeconds: 45 },
        'dep',
        { requests: { cpu: '100m' } }
      );

      expect(calls[0].args).to.include('--request-timeout=45s');
      expect(calls[0].options.timeout).to.be.above(45000);
    });

    it('falls back to its own message when kubectl says nothing', async () => {
      const calls = [];
      const kubectl = stubbedKubectl(calls, { stdout: '  \n', stderr: '', code: 0 });

      const result = await kubectl.setResources({ context: 'c', namespace: 'n' }, 'dep', {
        requests: { cpu: '100m' },
      });

      expect(result.message).to.equal('dep resources updated');
    });

    it('refuses to spawn kubectl for an invalid quantity', async () => {
      const calls = [];
      const kubectl = stubbedKubectl(calls, { stdout: '', stderr: '', code: 0 });

      const result = await kubectl.setResources({ context: 'c', namespace: 'n' }, 'dep', {
        requests: { cpu: '-1' },
      });

      expect(calls).to.have.lengthOf(0);
      expect(result.error.kind).to.equal('invalid');
    });

    it('classifies a failure rather than throwing', async () => {
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': stubExecutor({
          stdout: '',
          stderr: 'Error from server (Forbidden): deployments.apps is forbidden',
          code: 1,
        }),
      });

      const result = await kubectl.setResources({ context: 'c', namespace: 'n' }, 'dep', {
        requests: { cpu: '100m' },
      });

      expect(result.error.kind).to.equal('rbac');
    });
  });

  describe('createJobFromCronJob', () => {
    it('builds the full command as separate arguments', async () => {
      const calls = [];
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': {
          run: (bin, args, options) => {
            calls.push({ bin, args, options });
            return Promise.resolve({ stdout: 'job.batch/manual-run created', stderr: '', code: 0 });
          },
        },
      });

      const result = await kubectl.createJobFromCronJob(
        { context: 'ctx-stg', namespace: 'ns-stg', timeoutSeconds: 30 },
        'atwcronexpiringpoints-reminder',
        'manual-run'
      );

      expect(calls[0].bin).to.equal('kubectl');
      expect(calls[0].args).to.deep.equal([
        'create',
        'job',
        'manual-run',
        '--from=cronjob/atwcronexpiringpoints-reminder',
        '--context',
        'ctx-stg',
        '--namespace',
        'ns-stg',
        '--request-timeout=30s',
      ]);
      expect(result.message).to.equal('job.batch/manual-run created');
    });

    it('falls back to its own message when kubectl says nothing', async () => {
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': stubExecutor({ stdout: '', stderr: '', code: 0 }),
      });

      const result = await kubectl.createJobFromCronJob({ context: 'c', namespace: 'n' }, 'cron', 'run-1');

      expect(result.message).to.equal('run-1 created from cron');
    });

    it('classifies a name that is already taken', async () => {
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': stubExecutor({
          stdout: '',
          stderr: 'error: failed to create job: jobs.batch "run-1" already exists',
          code: 1,
        }),
      });

      const result = await kubectl.createJobFromCronJob({ context: 'c', namespace: 'n' }, 'cron', 'run-1');

      expect(result.error.kind).to.equal('unknown');
      expect(result.error.raw).to.contain('already exists');
    });
  });

  describe('getCronJobs', () => {
    const payload = {
      items: [
        {
          metadata: { name: 'atwcronexpiringpoints-reminder' },
          spec: { schedule: '0 1 * * *', suspend: false },
          status: { lastScheduleTime: '2026-09-16T01:00:00Z' },
        },
        {
          metadata: { name: 'atwcronsettlement' },
          spec: { schedule: '*/15 * * * *', suspend: true },
          status: {},
        },
      ],
    };

    it('asks for json, scoped to the target', async () => {
      const calls = [];
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': {
          run: (bin, args, options) => {
            calls.push({ bin, args, options });
            return Promise.resolve({ stdout: '{"items":[]}', stderr: '', code: 0 });
          },
        },
      });

      await kubectl.getCronJobs({ context: 'ctx-stg', namespace: 'ns-stg', timeoutSeconds: 30 });

      expect(calls[0].bin).to.equal('kubectl');
      expect(calls[0].args).to.deep.equal([
        'get',
        'cronjobs',
        '--context',
        'ctx-stg',
        '--namespace',
        'ns-stg',
        '--request-timeout=30s',
        '-o',
        'json',
      ]);
      expect(calls[0].options.timeout).to.be.above(30000);
    });

    it('maps each item to the four columns the UI shows', async () => {
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': stubExecutor({ stdout: JSON.stringify(payload), stderr: '', code: 0 }),
      });

      const result = await kubectl.getCronJobs({ context: 'c', namespace: 'n' });

      expect(result.cronjobs).to.deep.equal([
        {
          name: 'atwcronexpiringpoints-reminder',
          schedule: '0 1 * * *',
          suspend: false,
          lastScheduleTime: '2026-09-16T01:00:00Z',
        },
        {
          name: 'atwcronsettlement',
          schedule: '*/15 * * * *',
          suspend: true,
          lastScheduleTime: null,
        },
      ]);
    });

    it('reports a cronjob that has never run as null', async () => {
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': stubExecutor({
          stdout: JSON.stringify({
            items: [{ metadata: { name: 'fresh' }, spec: { schedule: '@daily' } }],
          }),
          stderr: '',
          code: 0,
        }),
      });

      const result = await kubectl.getCronJobs({ context: 'c', namespace: 'n' });

      expect(result.cronjobs[0].lastScheduleTime).to.equal(null);
      expect(result.cronjobs[0].suspend).to.equal(false);
    });

    it('returns an empty list when the namespace has no cronjobs', async () => {
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': stubExecutor({ stdout: '{"items":[]}', stderr: '', code: 0 }),
      });

      expect((await kubectl.getCronJobs({ context: 'c', namespace: 'n' })).cronjobs).to.deep.equal([]);
    });

    it('surfaces a failure instead of swallowing it, unlike getScaledObjects', async () => {
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': stubExecutor({
          stdout: '',
          stderr: 'Error from server (Forbidden): cronjobs.batch is forbidden',
          code: 1,
        }),
      });

      const result = await kubectl.getCronJobs({ context: 'c', namespace: 'n' });

      expect(result.error.kind).to.equal('rbac');
      expect(result.cronjobs).to.equal(undefined);
    });
  });

  describe('classifyError', () => {
    const kubectl = require('../lib/k8s/kubectl');

    it('detects expired credentials', () => {
      expect(kubectl.classifyError('error: You must be logged in').kind).to.equal('auth');
    });

    it('detects missing RBAC access', () => {
      expect(
        kubectl.classifyError('pods is forbidden: User cannot list resource').kind
      ).to.equal('rbac');
    });

    it('detects a timeout', () => {
      expect(
        kubectl.classifyError('error: Get "https://k8s": context deadline exceeded').kind
      ).to.equal('timeout');
    });

    it('falls back to unknown', () => {
      expect(kubectl.classifyError('something else broke').kind).to.equal('unknown');
    });
  });
});
