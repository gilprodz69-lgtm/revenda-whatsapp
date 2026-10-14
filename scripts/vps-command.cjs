#!/usr/bin/env node
'use strict';
// No credentials belong in the command. Git reads private-repository credentials from the terminal.
const repository = 'gilprodz69-lgtm/revenda-whatsapp';
const { version } = require('../package.json');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Versão de instalação inválida');
const script = [
  'set -euo pipefail',
  '. /etc/os-release',
  '[[ "$ID" = ubuntu && "$VERSION_ID" = 24.04 ]] || { echo "Use Ubuntu Server 24.04 LTS." >&2; exit 1; }',
  'apt-get update -qq',
  'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates git',
  'd=/opt/revenda-whatsapp',
  `u=https://github.com/${repository}.git`,
  'if [[ ! -e "$d" ]]; then printf "Repositório privado: informe usuário GitHub e token com acesso de leitura. O token não será salvo.\\n"; git -c credential.helper= -c credential.useHttpPath=true clone --branch v' +
    version +
    ' --single-branch "$u" "$d"; else [[ ! -L "$d" && -d "$d/.git" && "$(git -C "$d" remote get-url origin)" = "$u" ]] || { echo "Diretório existente não pertence a este projeto." >&2; exit 1; }; fi',
  'exec bash "$d/scripts/install.sh"',
].join('; ');
const command = 'sudo bash -c ' + "'" + script.replaceAll("'", "'\\''") + "'";
if (require.main === module) process.stdout.write(command + '\n');
module.exports = { command, script, repository };
