'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');
const config = require('../lib/config');

function writeConfig(contents) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kube-tools-config-')),
    '.kube-tools.yaml'
  );

  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

describe('config', () => {
  describe('load', () => {
    it('expands a leading ~ to the home directory', () => {
      const loaded = config.load(writeConfig('workspaceRoot: ~/Desktop/cermati\n'));

      expect(loaded.workspaceRoot).to.equal(
        path.join(os.homedir(), 'Desktop', 'cermati')
      );
    });

    it('expands a bare ~', () => {
      const loaded = config.load(writeConfig('workspaceRoot: "~"\n'));

      expect(loaded.workspaceRoot).to.equal(os.homedir());
    });

    it('leaves an already absolute path alone', () => {
      const loaded = config.load(writeConfig('workspaceRoot: /srv/repos\n'));

      expect(loaded.workspaceRoot).to.equal('/srv/repos');
    });

    it('does not expand a ~ that is not at the start', () => {
      const loaded = config.load(writeConfig('workspaceRoot: /srv/~backup/repos\n'));

      expect(loaded.workspaceRoot).to.equal('/srv/~backup/repos');
    });

    it('tells the user to copy the example file when there is no config', () => {
      const missing = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'kube-tools-config-')),
        '.kube-tools.yaml'
      );

      expect(() => config.load(missing)).to.throw(
        /Copy \.kube-tools\.example\.yaml to \.kube-tools\.yaml/
      );
      expect(() => config.load(missing)).to.throw(/workspaceRoot/);
    });

    it('rejects a relative workspaceRoot rather than guessing a root', () => {
      expect(() => config.load(writeConfig('workspaceRoot: cermati\n'))).to.throw(
        /must be an absolute path/
      );
    });

    it('rejects a missing workspaceRoot', () => {
      expect(() => config.load(writeConfig('versionPattern: null\n'))).to.throw(
        /workspaceRoot is required/
      );
    });

    it('defaults versionPattern to null', () => {
      const loaded = config.load(
        writeConfig('workspaceRoot: /srv/repos\nversionPattern: null\n')
      );

      expect(loaded.versionPattern).to.equal(null);
    });

    it('keeps a configured versionPattern as a string', () => {
      const loaded = config.load(
        writeConfig('workspaceRoot: /srv/repos\nversionPattern: "img-[0-9]+"\n')
      );

      expect(loaded.versionPattern).to.equal('img-[0-9]+');
    });

    it('rejects a versionPattern that will not compile', () => {
      expect(() =>
        config.load(writeConfig('workspaceRoot: /srv/repos\nversionPattern: "a("\n'))
      ).to.throw(/not a valid regex/);
    });
  });

  describe('repoDir', () => {
    it('joins the repo onto the workspace root', () => {
      expect(config.repoDir('/srv/repos', 'athena')).to.equal('/srv/repos/athena');
    });
  });
});
