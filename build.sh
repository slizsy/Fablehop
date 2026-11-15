#!/bin/bash
# Copies src/ into brave/ and firefox/, each with its own manifest.
# Run this after changing anything in src/.
set -e
cd "$(dirname "$0")"
for target in brave firefox; do
  rm -rf "$target"
  cp -R src "$target"
  cp "manifest.$target.json" "$target/manifest.json"
done
echo "built brave/ and firefox/"
