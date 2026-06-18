#!/bin/sh
set -eu

if [ -n "${VAULT_AGENT_GIT_SSH_PRIVATE_KEY:-}" ]; then
  ssh_dir="${HOME:-/home/node}/.ssh"
  key_file="$ssh_dir/vault_agent_git_ssh_key"
  known_hosts_file="$ssh_dir/known_hosts"

  mkdir -p "$ssh_dir"
  chmod 700 "$ssh_dir"

  printf '%s\n' "$VAULT_AGENT_GIT_SSH_PRIVATE_KEY" > "$key_file"
  chmod 600 "$key_file"
  unset VAULT_AGENT_GIT_SSH_PRIVATE_KEY

  if [ -n "${VAULT_AGENT_GIT_SSH_KNOWN_HOSTS:-}" ]; then
    printf '%s\n' "$VAULT_AGENT_GIT_SSH_KNOWN_HOSTS" > "$known_hosts_file"
    chmod 600 "$known_hosts_file"
    unset VAULT_AGENT_GIT_SSH_KNOWN_HOSTS
    export GIT_SSH_COMMAND="ssh -i $key_file -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$known_hosts_file"
  else
    export GIT_SSH_COMMAND="ssh -i $key_file -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  fi
fi

exec node /app/packages/cli/dist/main.js "$@"
