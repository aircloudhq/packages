# @aircloudhq/cli

The `aircloud` command-line interface for [Air-Cloud](https://github.com/aircloudhq/packages): create a
product in its conventional shape, check it with the same engine the platform runs, and release it.

```sh
npm install -g @aircloudhq/cli
aircloud version
```

npm installs the native binary for your machine — macOS or Linux, x64 or arm64 — as one of this package's
optional dependencies (`@aircloudhq/cli-<platform>-<arch>`), and the `aircloud` command runs it. Each
binary is taken from the platform's signed release: the release's `checksums.txt` is signed with the
platform's release key and verified before any channel is built from it, and npm's integrity check carries
those bytes to your machine.

Upgrade with npm (`npm install -g @aircloudhq/cli@latest`); `aircloud upgrade` defers to npm for an
npm-installed binary.

If your install skipped optional dependencies (`--omit=optional`), `aircloud` names the platform package it
could not find; reinstall without that flag.
