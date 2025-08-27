#!/bin/bash

# Delete repositories piped from stdin
# Only deletes repositories that start with "auto-merge-test-" for safety
while IFS= read -r repo_name; do
    if [[ "$repo_name" =~ ^auto-merge-test-.* ]]; then
        echo "Deleting repository: $repo_name"
        gh repo delete "$repo_name" --yes
    else
        echo "Skipping $repo_name - doesn't match auto-merge-test-* pattern"
    fi
done