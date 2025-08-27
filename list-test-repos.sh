#!/bin/bash

# List all repositories with pattern auto-merge-test-*
gh repo list --limit 1000 --json name | jq -r '.[] | select(.name | startswith("auto-merge-test-")) | .name'