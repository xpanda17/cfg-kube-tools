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
