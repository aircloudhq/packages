# Air-Cloud packages

The npm packages of the Air-Cloud platform, as published on npmjs.

- [`@aircloudhq/testing`](aircloud-testing/) — In-memory capability doubles for Air-Cloud JavaScript functions, generated from the aircloud:capability WIT contract, plus the fetch-event harness for node:test unit tests.
- [`@aircloudhq/web`](aircloud-web/) — The application package of an Air-Cloud product: the Rails Action View helpers, i18n over the product's locale bundle, resource pages over its models, and React bindings, for its site and its JavaScript functions.

Each directory holds exactly what its package ships in the npm tarball: its `package.json`, README,
LICENSE and the files the package publishes. Install a package from npm, not from this repository.

## Contributing

This repository is a read-only mirror. The packages are developed in the Air-Cloud platform's own
repository, and every commit here is written by the mirror from there.

- **Issues are welcome.** Report a bug or ask a question in this repository's issues.
- **Code changes land upstream.** Pull requests are not merged here: a change is made in the
  platform repository and reaches this mirror with the next sync.

## License

MIT — see [LICENSE](LICENSE).
