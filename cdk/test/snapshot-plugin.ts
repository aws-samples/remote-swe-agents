module.exports = {
  test: (val: any) => typeof val === 'string',
  serialize: (val: any) => {
    return `"${val //
      .replace(/([A-Fa-f0-9]{64}.zip)/, 'REDACTED')
      .replace(/worker-asset-hash:([A-Fa-f0-9]{64})/, 'REDACTED')
      .replace(/.*cdk-hnb659fds-container-assets-.*/, 'REDACTED')}"`;
  },
};
