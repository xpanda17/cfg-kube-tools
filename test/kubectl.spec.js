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

  describe('getJobsForCronJob', () => {
    const payload = {
      items: [
        {
          metadata: {
            name: 'reminder-29823960',
            ownerReferences: [{ kind: 'CronJob', name: 'atwcron-reminder' }],
          },
          spec: {},
          status: {},
        },
        {
          metadata: {
            name: 'reminder-29823900',
            ownerReferences: [{ kind: 'CronJob', name: 'atwcron-reminder' }],
          },
          spec: { suspend: true },
          status: { completionTime: '2026-09-16T01:05:00Z' },
        },
        {
          metadata: {
            name: 'settlement-29823960',
            ownerReferences: [{ kind: 'CronJob', name: 'atwcron-settlement' }],
          },
          spec: {},
          status: {},
        },
        { metadata: { name: 'hand-rolled-job' }, spec: {}, status: {} },
      ],
    };

    function kubectlFor(stdout) {
      return proxyquire('../lib/k8s/kubectl', {
        '../core/executor': stubExecutor({ stdout, stderr: '', code: 0 }),
      });
    }

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

      await kubectl.getJobsForCronJob(
        { context: 'ctx-stg', namespace: 'ns-stg', timeoutSeconds: 30 },
        'atwcron-reminder'
      );

      expect(calls[0].bin).to.equal('kubectl');
      expect(calls[0].args).to.deep.equal([
        'get',
        'jobs',
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

    it('keeps only the jobs this cronjob owns', async () => {
      const kubectl = kubectlFor(JSON.stringify(payload));

      const result = await kubectl.getJobsForCronJob(
        { context: 'c', namespace: 'n' },
        'atwcron-reminder'
      );

      expect(result.jobs.map((job) => job.name)).to.deep.equal([
        'reminder-29823960',
        'reminder-29823900',
      ]);
    });

    it('ignores a job owned by nothing at all', async () => {
      const kubectl = kubectlFor(
        JSON.stringify({ items: [{ metadata: { name: 'hand-rolled-job' }, spec: {}, status: {} }] })
      );

      const result = await kubectl.getJobsForCronJob({ context: 'c', namespace: 'n' }, 'cron');

      expect(result.jobs).to.deep.equal([]);
    });

    it('ignores a job whose owner is a cronjob of the same name but another kind', async () => {
      const kubectl = kubectlFor(
        JSON.stringify({
          items: [{
            metadata: { name: 'j', ownerReferences: [{ kind: 'Job', name: 'cron' }] },
            spec: {},
            status: {},
          }],
        })
      );

      const result = await kubectl.getJobsForCronJob({ context: 'c', namespace: 'n' }, 'cron');

      expect(result.jobs).to.deep.equal([]);
    });

    it('reports suspension and completion per job', async () => {
      const kubectl = kubectlFor(JSON.stringify(payload));

      const result = await kubectl.getJobsForCronJob(
        { context: 'c', namespace: 'n' },
        'atwcron-reminder'
      );

      expect(result.jobs[0]).to.deep.equal({
        name: 'reminder-29823960',
        suspended: false,
        finished: false,
      });
      expect(result.jobs[1]).to.deep.equal({
        name: 'reminder-29823900',
        suspended: true,
        finished: true,
      });
    });

    it('surfaces a failure instead of an empty list', async () => {
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': stubExecutor({
          stdout: '',
          stderr: 'Error from server (Forbidden): jobs.batch is forbidden',
          code: 1,
        }),
      });

      const result = await kubectl.getJobsForCronJob({ context: 'c', namespace: 'n' }, 'cron');

      expect(result.error.kind).to.equal('rbac');
      expect(result.jobs).to.equal(undefined);
    });
  });

  describe('setCronJobSuspend', () => {
    const target = { context: 'ctx-stg', namespace: 'ns-stg', timeoutSeconds: 30 };

    function jobItem(name, suspended, finished) {
      return {
        metadata: { name, ownerReferences: [{ kind: 'CronJob', name: 'atwcron-reminder' }] },
        spec: suspended ? { suspend: true } : {},
        status: finished ? { completionTime: '2026-09-16T01:05:00Z' } : {},
      };
    }

    // Each call answers from the script in order, so a multi-step run can be
    // driven end to end, failure included.
    function scripted(calls, script) {
      return proxyquire('../lib/k8s/kubectl', {
        '../core/executor': {
          run: (bin, args, options) => {
            calls.push({ bin, args, options });
            const next = script[calls.length - 1];

            return Promise.resolve(next || { stdout: 'patched', stderr: '', code: 0 });
          },
        },
      });
    }

    function patchTargets(calls) {
      return calls.filter((call) => call.args[0] === 'patch').map((call) => call.args[2]);
    }

    function jobsResponse(items) {
      return { stdout: JSON.stringify({ items }), stderr: '', code: 0 };
    }

    it('patches the cronjob with a merge patch when suspending', async () => {
      const calls = [];
      const kubectl = scripted(calls, []);

      const result = await kubectl.setCronJobSuspend(target, 'atwcron-reminder', true);

      expect(calls).to.have.lengthOf(1);
      expect(calls[0].bin).to.equal('kubectl');
      expect(calls[0].args).to.deep.equal([
        'patch',
        'cronjob',
        'atwcron-reminder',
        '--type=merge',
        '-p',
        '{"spec":{"suspend":true}}',
        '--context',
        'ctx-stg',
        '--namespace',
        'ns-stg',
        '--request-timeout=30s',
      ]);
      expect(result.steps).to.deep.equal(['atwcron-reminder schedule suspended']);
    });

    it('sends false, not a string, when resuming', async () => {
      const calls = [];
      const kubectl = scripted(calls, []);

      const result = await kubectl.setCronJobSuspend(target, 'atwcron-reminder', false);

      expect(calls[0].args).to.include('{"spec":{"suspend":false}}');
      expect(result.steps).to.deep.equal(['atwcron-reminder schedule resumed']);
    });

    it('does not look at the jobs unless asked to', async () => {
      const calls = [];
      const kubectl = scripted(calls, []);

      await kubectl.setCronJobSuspend(target, 'atwcron-reminder', true, false);

      expect(calls).to.have.lengthOf(1);
      expect(calls.map((call) => call.args[1])).to.deep.equal(['cronjob']);
    });

    it('suspends every running job, skipping the finished and the already suspended', async () => {
      const calls = [];
      const kubectl = scripted(calls, [
        { stdout: 'patched', stderr: '', code: 0 },
        jobsResponse([
          jobItem('reminder-running', false, false),
          jobItem('reminder-done', false, true),
          jobItem('reminder-already', true, false),
          jobItem('reminder-second', false, false),
        ]),
      ]);

      const result = await kubectl.setCronJobSuspend(target, 'atwcron-reminder', true, true);

      expect(calls[1].args.slice(0, 2)).to.deep.equal(['get', 'jobs']);
      expect(patchTargets(calls)).to.deep.equal([
        'atwcron-reminder',
        'reminder-running',
        'reminder-second',
      ]);
      expect(result.steps).to.deep.equal([
        'atwcron-reminder schedule suspended',
        'reminder-running suspended',
        'reminder-second suspended',
      ]);
    });

    it('patches a job with the same merge patch as the cronjob', async () => {
      const calls = [];
      const kubectl = scripted(calls, [
        { stdout: 'patched', stderr: '', code: 0 },
        jobsResponse([jobItem('reminder-running', false, false)]),
      ]);

      await kubectl.setCronJobSuspend(target, 'atwcron-reminder', true, true);

      expect(calls[2].args).to.deep.equal([
        'patch',
        'job',
        'reminder-running',
        '--type=merge',
        '-p',
        '{"spec":{"suspend":true}}',
        '--context',
        'ctx-stg',
        '--namespace',
        'ns-stg',
        '--request-timeout=30s',
      ]);
    });

    it('resumes only the jobs that are actually suspended', async () => {
      const calls = [];
      const kubectl = scripted(calls, [
        { stdout: 'patched', stderr: '', code: 0 },
        jobsResponse([
          jobItem('reminder-suspended', true, false),
          jobItem('reminder-running', false, false),
        ]),
      ]);

      const result = await kubectl.setCronJobSuspend(target, 'atwcron-reminder', false, true);

      expect(patchTargets(calls)).to.deep.equal([
        'atwcron-reminder',
        'reminder-suspended',
      ]);
      expect(result.steps[1]).to.equal('reminder-suspended resumed');
    });

    it('never touches a finished job, even a suspended one', async () => {
      const calls = [];
      const kubectl = scripted(calls, [
        { stdout: 'patched', stderr: '', code: 0 },
        jobsResponse([jobItem('reminder-done', true, true)]),
      ]);

      const result = await kubectl.setCronJobSuspend(target, 'atwcron-reminder', false, true);

      expect(calls).to.have.lengthOf(2);
      expect(result.steps).to.deep.equal([
        'atwcron-reminder schedule resumed',
        'no running jobs to resume',
      ]);
    });

    it('says so when no job qualifies, rather than reporting nothing', async () => {
      const calls = [];
      const kubectl = scripted(calls, [
        { stdout: 'patched', stderr: '', code: 0 },
        jobsResponse([]),
      ]);

      const result = await kubectl.setCronJobSuspend(target, 'atwcron-reminder', true, true);

      expect(result.steps).to.deep.equal([
        'atwcron-reminder schedule suspended',
        'no running jobs to suspend',
      ]);
    });

    it('stops at the cronjob patch when it fails, with no steps taken', async () => {
      const calls = [];
      const kubectl = scripted(calls, [
        {
          stdout: '',
          stderr: 'Error from server (Forbidden): cronjobs.batch is forbidden',
          code: 1,
        },
      ]);

      const result = await kubectl.setCronJobSuspend(target, 'atwcron-reminder', true, true);

      expect(calls).to.have.lengthOf(1);
      expect(result.error.kind).to.equal('rbac');
      expect(result.steps).to.deep.equal([]);
    });

    it('keeps the schedule step when the job listing fails', async () => {
      const calls = [];
      const kubectl = scripted(calls, [
        { stdout: 'patched', stderr: '', code: 0 },
        { stdout: '', stderr: 'Unable to connect to the server: dial tcp', code: 1 },
      ]);

      const result = await kubectl.setCronJobSuspend(target, 'atwcron-reminder', true, true);

      expect(result.error.kind).to.equal('network');
      expect(result.steps).to.deep.equal(['atwcron-reminder schedule suspended']);
    });

    it('returns the steps already taken when a job patch fails midway', async () => {
      const calls = [];
      const kubectl = scripted(calls, [
        { stdout: 'patched', stderr: '', code: 0 },
        jobsResponse([
          jobItem('reminder-one', false, false),
          jobItem('reminder-two', false, false),
          jobItem('reminder-three', false, false),
        ]),
        { stdout: 'patched', stderr: '', code: 0 },
        { stdout: '', stderr: 'Error from server (Forbidden): jobs.batch is forbidden', code: 1 },
      ]);

      const result = await kubectl.setCronJobSuspend(target, 'atwcron-reminder', true, true);

      // The third job is never attempted: the run stops at the failure.
      expect(calls).to.have.lengthOf(4);
      expect(result.error.kind).to.equal('rbac');
      expect(result.steps).to.deep.equal([
        'atwcron-reminder schedule suspended',
        'reminder-one suspended',
      ]);
    });
  });

  describe('setJobSuspend', () => {
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

    it('patches the one job, not its cronjob', async () => {
      const calls = [];
      const kubectl = stubbedKubectl(calls, {
        stdout: 'job.batch/reminder-29823960 patched',
        stderr: '',
        code: 0,
      });

      const result = await kubectl.setJobSuspend(
        { context: 'ctx-stg', namespace: 'ns-stg', timeoutSeconds: 30 },
        'reminder-29823960',
        true
      );

      expect(calls[0].bin).to.equal('kubectl');
      expect(calls[0].args).to.deep.equal([
        'patch',
        'job',
        'reminder-29823960',
        '--type=merge',
        '-p',
        '{"spec":{"suspend":true}}',
        '--context',
        'ctx-stg',
        '--namespace',
        'ns-stg',
        '--request-timeout=30s',
      ]);
      expect(result.message).to.equal('job.batch/reminder-29823960 patched');
    });

    it('sends a json boolean, not a string, when resuming', async () => {
      const calls = [];
      const kubectl = stubbedKubectl(calls, { stdout: '', stderr: '', code: 0 });

      await kubectl.setJobSuspend({ context: 'c', namespace: 'n' }, 'job-1', false);

      expect(calls[0].args[5]).to.equal('{"spec":{"suspend":false}}');
      expect(JSON.parse(calls[0].args[5]).spec.suspend).to.equal(false);
    });

    it('applies the target timeout to kubectl and the executor', async () => {
      const calls = [];
      const kubectl = stubbedKubectl(calls, { stdout: '', stderr: '', code: 0 });

      await kubectl.setJobSuspend(
        { context: 'c', namespace: 'n', timeoutSeconds: 45 },
        'job-1',
        true
      );

      expect(calls[0].args).to.include('--request-timeout=45s');
      expect(calls[0].options.timeout).to.be.above(45000);
    });

    it('falls back to its own message when kubectl says nothing', async () => {
      const calls = [];
      const kubectl = stubbedKubectl(calls, { stdout: '  \n', stderr: '', code: 0 });

      expect(
        (await kubectl.setJobSuspend({ context: 'c', namespace: 'n' }, 'job-1', true)).message
      ).to.equal('job-1 suspended');
      expect(
        (await kubectl.setJobSuspend({ context: 'c', namespace: 'n' }, 'job-1', false)).message
      ).to.equal('job-1 resumed');
    });

    it('classifies a failure rather than throwing', async () => {
      const kubectl = proxyquire('../lib/k8s/kubectl', {
        '../core/executor': stubExecutor({
          stdout: '',
          stderr: 'Error from server (NotFound): jobs.batch "job-1" not found',
          code: 1,
        }),
      });

      const result = await kubectl.setJobSuspend({ context: 'c', namespace: 'n' }, 'job-1', true);

      expect(result.error.kind).to.equal('unknown');
      expect(result.error.raw).to.contain('not found');
      expect(result.message).to.equal(undefined);
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
