'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');
const registry = require('../lib/registry');

function writeRegistry(contents) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kube-tools-')),
    'services.yaml'
  );

  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

const VALID = `
services:
  - name: athenaapp
    label: Athena App
    repo: athena
    build: athena
    envs:
      - name: stg
        label: Staging
        context: cluster02-staging-indodana-cermati-indodana-athena-stg
        namespace: cermati-indodana-athena-stg
`;

describe('registry', () => {
  describe('load', () => {
    it('reads a valid registry', () => {
      const loaded = registry.load(writeRegistry(VALID));

      expect(loaded.services).to.have.lengthOf(1);
      expect(loaded.services[0].envs[0].namespace).to.equal('cermati-indodana-athena-stg');
    });

    it('rejects a value that could be read as a kubectl flag', () => {
      const file = writeRegistry(`
services:
  - name: evil
    envs:
      - name: stg
        context: --token=leaked
        namespace: default
`);

      expect(() => registry.load(file)).to.throw(/invalid context/);
    });

    it('rejects a service with no envs', () => {
      const file = writeRegistry('services:\n  - name: lonely\n');

      expect(() => registry.load(file)).to.throw(/no envs/);
    });

    it('rejects an empty registry', () => {
      expect(() => registry.load(writeRegistry('services: []'))).to.throw(/non-empty/);
    });

    it('defaults the timeout when none is declared', () => {
      const loaded = registry.load(writeRegistry(VALID));

      expect(registry.resolve(loaded, 'athenaapp', 'stg').timeoutSeconds).to.equal(
        registry.DEFAULT_TIMEOUT_SECONDS
      );
    });

    it('lets an env override the top-level timeout', () => {
      const file = writeRegistry(`
timeoutSeconds: 30
services:
  - name: athenaapp
    envs:
      - name: stg
        context: ctx
        namespace: ns
      - name: prod
        context: ctx-prod
        namespace: ns-prod
        timeoutSeconds: 120
`);
      const loaded = registry.load(file);

      expect(registry.resolve(loaded, 'athenaapp', 'stg').timeoutSeconds).to.equal(30);
      expect(registry.resolve(loaded, 'athenaapp', 'prod').timeoutSeconds).to.equal(120);
    });

    it('accepts a service with no repo or build', () => {
      const file = writeRegistry(`
services:
  - name: plain
    envs:
      - name: stg
        context: c
        namespace: n
`);
      const loaded = registry.load(file);

      expect(registry.resolve(loaded, 'plain', 'stg').repo).to.equal(null);
      expect(registry.resolve(loaded, 'plain', 'stg').build).to.equal(null);
    });

    it('rejects a repo that could be read as a flag', () => {
      const file = writeRegistry(`
services:
  - name: evil
    repo: --commit
    envs:
      - name: stg
        context: c
        namespace: n
`);

      expect(() => registry.load(file)).to.throw(/invalid repo/);
    });

    it('rejects a build that could be read as a flag', () => {
      const file = writeRegistry(`
services:
  - name: evil
    build: ../../etc
    envs:
      - name: stg
        context: c
        namespace: n
`);

      expect(() => registry.load(file)).to.throw(/invalid build/);
    });

    it('rejects a timeout that is not a sane number', () => {
      const file = writeRegistry(`
timeoutSeconds: 9000
services:
  - name: a
    envs:
      - name: stg
        context: c
        namespace: n
`);

      expect(() => registry.load(file)).to.throw(/timeoutSeconds/);
    });
  });

  describe('resolve', () => {
    const loaded = { services: [{ name: 'a', envs: [{ name: 'stg', context: 'c', namespace: 'n' }] }] };

    it('returns the cluster target', () => {
      expect(registry.resolve(loaded, 'a', 'stg')).to.deep.equal({
        context: 'c',
        namespace: 'n',
        timeoutSeconds: registry.DEFAULT_TIMEOUT_SECONDS,
        service: 'a',
        env: 'stg',
        repo: null,
        build: null,
      });
    });

    it('surfaces the pipeline repo and build on the target', () => {
      const target = registry.resolve(registry.load(writeRegistry(VALID)), 'athenaapp', 'stg');

      expect(target.repo).to.equal('athena');
      expect(target.build).to.equal('athena');
      expect(target.service).to.equal('athenaapp');
      expect(target.env).to.equal('stg');
    });

    it('rejects an unknown service with a 400', () => {
      expect(() => registry.resolve(loaded, 'nope', 'stg')).to.throw(/Unknown service/);
    });

    it('rejects an unknown env', () => {
      expect(() => registry.resolve(loaded, 'a', 'prod')).to.throw(/Unknown env/);
    });
  });

  describe('toMenu', () => {
    it('exposes repo and build so the UI can prefill the deploy form', () => {
      const menu = registry.toMenu(registry.load(writeRegistry(VALID)));

      expect(menu[0].repo).to.equal('athena');
      expect(menu[0].build).to.equal('athena');
    });

    it('hides context and namespace from the UI payload', () => {
      const menu = registry.toMenu(registry.load(writeRegistry(VALID)));

      expect(menu[0].label).to.equal('Athena App');
      expect(menu[0].envs[0]).to.deep.equal({ name: 'stg', label: 'Staging' });
      expect(menu[0]).to.not.have.property('timeoutSeconds');
    });
  });
});
