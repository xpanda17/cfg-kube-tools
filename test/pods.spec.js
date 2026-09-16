'use strict';

const { expect } = require('chai');
const pods = require('../lib/k8s/pods');

describe('pods', () => {
  describe('formatAge', () => {
    it('renders seconds below two minutes', () => {
      expect(pods.formatAge(45 * 1000)).to.equal('45s');
    });

    it('renders hours and minutes', () => {
      expect(pods.formatAge((4 * 60 + 32) * 60 * 1000)).to.equal('4h32m');
    });

    it('renders days and hours', () => {
      expect(pods.formatAge((6 * 24 + 1) * 60 * 60 * 1000)).to.equal('6d1h');
    });
  });

  describe('deriveStatus', () => {
    it('reports a waiting reason instead of the phase', () => {
      const pod = {
        metadata: {},
        status: {
          phase: 'Running',
          containerStatuses: [
            { state: { waiting: { reason: 'CrashLoopBackOff' } } },
          ],
        },
      };

      expect(pods.deriveStatus(pod)).to.equal('CrashLoopBackOff');
    });

    it('reports Terminating when the pod is being deleted', () => {
      const pod = {
        metadata: { deletionTimestamp: '2026-09-15T00:00:00Z' },
        status: { phase: 'Running', containerStatuses: [] },
      };

      expect(pods.deriveStatus(pod)).to.equal('Terminating');
    });

    it('falls back to the phase when nothing is wrong', () => {
      const pod = {
        metadata: {},
        status: { phase: 'Running', containerStatuses: [{ ready: true, state: {} }] },
      };

      expect(pods.deriveStatus(pod)).to.equal('Running');
    });
  });

  describe('categorize', () => {
    function makePod(deployment, hash, labels, ownerKind, ports) {
      return {
        metadata: {
          name: `${deployment}-${hash}-abcde`,
          labels: Object.assign({ 'pod-template-hash': hash }, labels),
          ownerReferences: [{ kind: ownerKind || 'ReplicaSet', name: `${deployment}-${hash}` }],
        },
        spec: { containers: [{ name: deployment, ports: ports || [] }] },
        status: { phase: 'Running', containerStatuses: [] },
      };
    }

    it('buckets a Job-owned pod as a cronjob', () => {
      const pod = makePod('atwcronexpiringpoints-reminder-29823960', 'x', {}, 'Job');

      expect(pods.categorize(pod)).to.equal('cronjob');
    });

    it('buckets a canary release channel as canary', () => {
      const pod = makePod('athenaapp-deployment', 'abc123', {
        'cfgroot.k8s.cicd/release_channel': 'canary',
      });

      expect(pods.categorize(pod)).to.equal('canary');
    });

    it('buckets the sut release channel as sut', () => {
      const pod = makePod('athenaapp-sut-adt-0720', 'abc123', {
        'cfgroot.k8s.cicd/release_channel': 'sut',
      });

      expect(pods.categorize(pod)).to.equal('sut');
    });

    it('buckets a load balancer, which carries no release channel', () => {
      const pod = makePod('athenaapp-lb', 'abc123', {});

      expect(pods.categorize(pod)).to.equal('lb');
    });

    it('buckets a port-serving deployment as app', () => {
      const pod = makePod('athenaapp-deployment', 'abc123', {
        'cfgroot.k8s.cicd/release_channel': 'stable',
      }, null, [{ name: 'http-api', containerPort: 3009 }]);

      expect(pods.categorize(pod)).to.equal('app');
    });

    it('treats an app from another product as an app, despite its name', () => {
      const pod = makePod('bureau-server-deployment', 'abc123', {
        'cfgroot.k8s.cicd/release_channel': 'stable',
      }, null, [{ name: 'http-api', containerPort: 8080 }]);

      expect(pods.categorize(pod)).to.equal('app');
    });

    it('buckets a portless deployment as a worker', () => {
      const pod = makePod('atwapplicationoffering-deployment', 'abc123', {
        'cfgroot.k8s.cicd/release_channel': 'stable',
      });

      expect(pods.categorize(pod)).to.equal('worker');
    });

    it('buckets a worker of an app-like product as a worker', () => {
      const pod = makePod('n8n-worker-deployment', 'abc123', {
        'cfgroot.k8s.cicd/release_channel': 'stable',
      });

      expect(pods.categorize(pod)).to.equal('worker');
    });

    it('prefers the cronjob bucket over a release channel', () => {
      const pod = makePod('atwcron-thing-123', 'x', {
        'cfgroot.k8s.cicd/release_channel': 'stable',
      }, 'Job');

      expect(pods.categorize(pod)).to.equal('cronjob');
    });
  });

  describe('deploymentName', () => {
    it('strips the pod-template-hash from the owning ReplicaSet', () => {
      const pod = {
        metadata: {
          name: 'athenaapp-deployment-596db77f5c-7wgrm',
          labels: { 'pod-template-hash': '596db77f5c' },
          ownerReferences: [{ kind: 'ReplicaSet', name: 'athenaapp-deployment-596db77f5c' }],
        },
      };

      expect(pods.deploymentName(pod)).to.equal('athenaapp-deployment');
    });

    it('returns null for a pod that is not ReplicaSet-owned', () => {
      const pod = {
        metadata: { name: 'job-pod', labels: {}, ownerReferences: [{ kind: 'Job', name: 'job-1' }] },
      };

      expect(pods.deploymentName(pod)).to.equal(null);
    });
  });

  describe('toRows', () => {
    const payload = {
      items: [
        {
          metadata: {
            name: 'athenaapp-deployment-587664fc4b-6v9dd',
            creationTimestamp: '2026-09-15T00:00:00Z',
          },
          spec: { nodeName: 'node-1' },
          status: {
            phase: 'Running',
            containerStatuses: [{ ready: true, restartCount: 0, state: {} }],
          },
        },
        {
          metadata: { name: 'athenaapp-lb-cb975b86d-6dgqh', creationTimestamp: '2026-09-15T00:00:00Z' },
          spec: { nodeName: 'node-2' },
          status: {
            phase: 'Running',
            containerStatuses: [
              { ready: true, restartCount: 1, state: {} },
              { ready: false, restartCount: 2, state: { waiting: { reason: 'ImagePullBackOff' } } },
            ],
          },
        },
      ],
    };

    it('flattens ready counts and sums restarts', () => {
      const rows = pods.toRows(payload, Date.parse('2026-09-15T04:32:00Z'));

      expect(rows[0].ready).to.equal('1/1');
      expect(rows[0].restarts).to.equal(0);
      expect(rows[0].age).to.equal('4h32m');
      expect(rows[1].ready).to.equal('1/2');
      expect(rows[1].restarts).to.equal(3);
    });

    it('marks a pod unhealthy when a container is not ready', () => {
      const rows = pods.toRows(payload, Date.now());

      expect(rows[0].healthy).to.equal(true);
      expect(rows[1].healthy).to.equal(false);
      expect(rows[1].status).to.equal('ImagePullBackOff');
    });

    it('returns an empty list when there are no items', () => {
      expect(pods.toRows({ items: [] })).to.deep.equal([]);
    });

    it('exposes container ports so the UI can offer a port forward', () => {
      const rows = pods.toRows({
        items: [{
          metadata: { name: 'app-1', labels: {}, creationTimestamp: new Date().toISOString() },
          spec: { containers: [{ ports: [{ containerPort: 3009 }, { containerPort: 3099 }] }] },
          status: { phase: 'Running', containerStatuses: [] },
        }],
      });

      expect(rows[0].ports).to.deep.equal([3009, 3099]);
    });

    it('exposes container requests and limits so the UI can prefill the spec form', () => {
      const rows = pods.toRows({
        items: [{
          metadata: { name: 'app-1', labels: {}, creationTimestamp: new Date().toISOString() },
          spec: {
            containers: [{
              name: 'athenaapp',
              resources: {
                requests: { cpu: '100m', memory: '128Mi' },
                limits: { cpu: '1', memory: '1Gi' },
              },
            }],
          },
          status: { phase: 'Running', containerStatuses: [] },
        }],
      });

      expect(rows[0].containers).to.deep.equal([{
        name: 'athenaapp',
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '1', memory: '1Gi' },
      }]);
    });

    it('reports an unset resource as null rather than dropping it', () => {
      const rows = pods.toRows({
        items: [{
          metadata: { name: 'app-1', labels: {}, creationTimestamp: new Date().toISOString() },
          spec: { containers: [{ name: 'athenaapp', resources: { requests: { cpu: '100m' } } }] },
          status: { phase: 'Running', containerStatuses: [] },
        }],
      });

      expect(rows[0].containers[0]).to.deep.equal({
        name: 'athenaapp',
        requests: { cpu: '100m', memory: null },
        limits: { cpu: null, memory: null },
      });
    });

    it('handles a container with no resources block at all', () => {
      const rows = pods.toRows({
        items: [{
          metadata: { name: 'app-1', labels: {}, creationTimestamp: new Date().toISOString() },
          spec: { containers: [{ name: 'sidecar' }] },
          status: { phase: 'Running', containerStatuses: [] },
        }],
      });

      expect(rows[0].containers[0].requests).to.deep.equal({ cpu: null, memory: null });
      expect(rows[0].containers[0].limits).to.deep.equal({ cpu: null, memory: null });
    });

    it('keeps one entry per container, in declaration order', () => {
      const rows = pods.toRows({
        items: [{
          metadata: { name: 'app-1', labels: {}, creationTimestamp: new Date().toISOString() },
          spec: {
            containers: [
              { name: 'athenaapp', resources: { requests: { cpu: '100m' } } },
              { name: 'istio-proxy', resources: { limits: { memory: '256Mi' } } },
            ],
          },
          status: { phase: 'Running', containerStatuses: [] },
        }],
      });

      expect(rows[0].containers.map((c) => c.name)).to.deep.equal(['athenaapp', 'istio-proxy']);
      expect(rows[0].containers[1].limits.memory).to.equal('256Mi');
    });

    it('returns an empty container list for a pod with no spec', () => {
      const rows = pods.toRows(payload, Date.now());

      expect(rows[0].containers).to.deep.equal([]);
    });

    it('no longer exposes the node name', () => {
      const rows = pods.toRows(payload, Date.now());

      expect(rows[0]).to.not.have.property('node');
    });
  });
});
