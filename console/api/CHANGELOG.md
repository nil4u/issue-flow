# Changelog

## [0.4.0](https://github.com/nil4u/issue-flow/compare/console-v0.3.1...console-v0.4.0) (2026-07-07)


### Features

* add Agentrix private cloud setup ([d0e0171](https://github.com/nil4u/issue-flow/commit/d0e017193855d1f53163276d8478ea58f804880c))
* **agentrix:** add private cloud runner setup ([ebdfa2b](https://github.com/nil4u/issue-flow/commit/ebdfa2b3051a7855b60e8d01953e289b22b8fd9a))
* **api:** add agentrix task forwarding metrics ([bd74036](https://github.com/nil4u/issue-flow/commit/bd74036c53d85f5acf0b804cc0eada4195657010))
* **console:** add issue list view and paginated repos ([48a0454](https://github.com/nil4u/issue-flow/commit/48a0454a767a30c4367434ee95b09da86bfe5273))


### Bug Fixes

* **agentrix:** simplify private cloud runner command ([3467bea](https://github.com/nil4u/issue-flow/commit/3467bea13fe6b6e4752ee83c48bba79b931dfabd))
* **api:** key forward cursors by cloud route ([5077a92](https://github.com/nil4u/issue-flow/commit/5077a924d99e83da9b0981efbef008aa8406cd97))
* avoid setup reset when bot PAT is missing ([c70eb2b](https://github.com/nil4u/issue-flow/commit/c70eb2bf83e43e9ae494f70e8b84407c820205eb))
* **console:** align repository list test contract ([06a1c7b](https://github.com/nil4u/issue-flow/commit/06a1c7b4cbb276c3fa5feb7f05b6769647106acf))
* create Agentrix runner token as GitLab PAT ([7f400e5](https://github.com/nil4u/issue-flow/commit/7f400e5ed58834287dd5bbdc4fd9f603a29d6442))
* generate runner token for admin GitLab user ([216875e](https://github.com/nil4u/issue-flow/commit/216875ed5308c63b22b6f4b6255c43529a19881c))
* require GitLab bot PAT during setup ([31ea1fe](https://github.com/nil4u/issue-flow/commit/31ea1fe4c821da4e7601040b52498de8630a6594))
* reuse GitLab bot PAT for Agentrix runner ([01e719f](https://github.com/nil4u/issue-flow/commit/01e719f35506a6a4ce45f0937fa91c655da982c4))
* validate Agentrix API responses with shared schemas ([33c7549](https://github.com/nil4u/issue-flow/commit/33c754987933fa8a8c638b72fc1632a42630d9c3))

## [0.3.1](https://github.com/nil4u/issue-flow/compare/console-v0.3.0...console-v0.3.1) (2026-07-06)


### Bug Fixes

* skip repo sync on repeat login ([adade30](https://github.com/nil4u/issue-flow/commit/adade30833b08a9957eb711677b1212e6e48d2ad))

## [0.3.0](https://github.com/nil4u/issue-flow/compare/console-v0.2.0...console-v0.3.0) (2026-07-06)


### Features

* release pending module updates ([d5ea4f8](https://github.com/nil4u/issue-flow/commit/d5ea4f8bd6675356ae800b54248bf515bf2da5f3))

## [0.2.0](https://github.com/nil4u/issue-flow/compare/console-v0.1.0...console-v0.2.0) (2026-07-04)


### Features

* **console:** serve web dist from the API and ship a production Docker image ([ec090d5](https://github.com/nil4u/issue-flow/commit/ec090d5be78bff8b546d2a71e1cff9a34e00d511))


### Bug Fixes

* **console:** configure plugin install directory ([a493389](https://github.com/nil4u/issue-flow/commit/a493389e46bebd4e96e15d1efb20424613cb8f34))
* **console:** handle install conflicts ([0104e4a](https://github.com/nil4u/issue-flow/commit/0104e4a2fd16fe104cfe40bb717c32f4a9a4f946))
