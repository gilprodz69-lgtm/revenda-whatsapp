#!/usr/bin/env node
'use strict';
// Public, versioned entry point; pipefail propagates download errors.
const repository = 'gilprodz69-lgtm/revenda-whatsapp';
const { version } = require('../package.json');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Versão de instalação inválida');
const script = `curl -fsSL --retry 3 --connect-timeout 15 https://raw.githubusercontent.com/${repository}/v${version}/scripts/bootstrap.sh | sudo --preserve-env=SSH_CONNECTION bash`;
const command = "bash -o pipefail -c '" + script + "'";
if (require.main === module) process.stdout.write(command + '\n');
module.exports = { command, script, repository };
