#!/usr/bin/env bash
cd "$(dirname "$0")/.."
ccr start &
sleep 4
exec node agent/agent.mjs
