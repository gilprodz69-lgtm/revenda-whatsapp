#!/usr/bin/env node
'use strict';
// Public, versioned entry point; pipefail propagates download errors.
const repository = 'gilprodz69-lgtm/revenda-whatsapp';
const { version } = require('../package.json');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Versão de instalação inválida');
const script = [
  'privilege=()',
  'if (( EUID != 0 )); then privilege=(sudo --preserve-env=SSH_CONNECTION); fi',
  'if ! command -v curl >/dev/null; then "${privilege[@]}" apt-get update -qq; "${privilege[@]}" apt-get install -y -qq curl ca-certificates; fi',
  `curl -fsSL --retry 3 --connect-timeout 15 https://raw.githubusercontent.com/${repository}/main/scripts/bootstrap.sh | "\${privilege[@]}" bash`,
].join('; ');
const command = "bash -o pipefail -ec '" + script + "'";
if (require.main === module) process.stdout.write(command + '\n');
module.exports = { command, script, repository };
