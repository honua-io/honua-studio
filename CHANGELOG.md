# Changelog

## [0.5.6](https://github.com/honua-io/honua-studio/compare/v0.5.5...v0.5.6) (2026-11-23)


### Bug Fixes

* **studio:** let the person publishing choose route and visibility ([#321](https://github.com/honua-io/honua-studio/issues/321)) ([455ca55](https://github.com/honua-io/honua-studio/commit/455ca5540effcdf0b52230f3a7425aec8885b43a))

## [0.5.5](https://github.com/honua-io/honua-studio/compare/v0.5.4...v0.5.5) (2026-11-22)


### Bug Fixes

* **e2e:** discover candidate data for the scripted MCP journey ([#315](https://github.com/honua-io/honua-studio/issues/315)) ([40ae8fc](https://github.com/honua-io/honua-studio/commit/40ae8fc7dccd15bdecdfb443635a2cdbaab912fc))
* **lifecycle:** require immutable saved publication intent ([#314](https://github.com/honua-io/honua-studio/issues/314)) ([ed6209b](https://github.com/honua-io/honua-studio/commit/ed6209b66fc56a1c7a95659fd9f9c1f9fd9f309b))
* **live:** apply configured certificate pin to cohort browser ([#313](https://github.com/honua-io/honua-studio/issues/313)) ([81bab08](https://github.com/honua-io/honua-studio/commit/81bab081dd0dd1b48c617a56e9b799c9cc92ce98))
* **live:** exercise full style journey on synthetic candidate polygons ([#310](https://github.com/honua-io/honua-studio/issues/310)) ([bda7a0e](https://github.com/honua-io/honua-studio/commit/bda7a0e1e44db2e8f95589d24267507618c5bdbb))
* **live:** exercise model-free candidate journeys ([1ac1538](https://github.com/honua-io/honua-studio/commit/1ac1538c454a7de5015e0be593c65d14c67c576a))
* **live:** explicitly assert disabled assistant on provider-free boot ([#309](https://github.com/honua-io/honua-studio/issues/309)) ([7ac33c7](https://github.com/honua-io/honua-studio/commit/7ac33c786ed3942fed5b74269e079d970abad23a))
* **live:** read top-level discovered tables ([#308](https://github.com/honua-io/honua-studio/issues/308)) ([e087401](https://github.com/honua-io/honua-studio/commit/e0874018d9be0e582b1dd697f97558e863c86a8b))
* **qualification:** add model-free OIDC lifecycle fixture ([#317](https://github.com/honua-io/honua-studio/issues/317)) ([92d6e4b](https://github.com/honua-io/honua-studio/commit/92d6e4bd63e72074941ba90fac5292e6a6dd7c5d))
* **studio:** approval-hold draft guards and preview release posture docs ([#295](https://github.com/honua-io/honua-studio/issues/295), [#301](https://github.com/honua-io/honua-studio/issues/301)) ([#302](https://github.com/honua-io/honua-studio/issues/302)) ([c6d55d0](https://github.com/honua-io/honua-studio/commit/c6d55d0d831e4d90672f5fdb44d2ceef9de67ad6))
* **studio:** preserve publication banner contrast in dark themes ([88a1d6b](https://github.com/honua-io/honua-studio/commit/88a1d6bd03a979c6f9f7d5e071a34ba603839245))
* **studio:** retain pending approval during live draft setup ([#319](https://github.com/honua-io/honua-studio/issues/319)) ([d0a2231](https://github.com/honua-io/honua-studio/commit/d0a22316e0ce35a42415106727f7a4c7184d523b))

## [0.5.4](https://github.com/honua-io/honua-studio/compare/v0.5.3...v0.5.4) (2026-11-20)


### Bug Fixes

* **editor:** save a version without re-sending a view the draft already holds ([#298](https://github.com/honua-io/honua-studio/issues/298)) ([#299](https://github.com/honua-io/honua-studio/issues/299)) ([15ab22f](https://github.com/honua-io/honua-studio/commit/15ab22fbbba0b603f55e1dbfc29e7e978e34f0ab))

## [0.5.3](https://github.com/honua-io/honua-studio/compare/v0.5.2...v0.5.3) (2026-11-20)


### Bug Fixes

* **editor:** report a Studio edit held for approval with its proposal ([#296](https://github.com/honua-io/honua-studio/issues/296)) ([1654a8e](https://github.com/honua-io/honua-studio/commit/1654a8ecaea81c29deda4595099988a2db0c38f1)), closes [#294](https://github.com/honua-io/honua-studio/issues/294)

## [0.5.2](https://github.com/honua-io/honua-studio/compare/v0.5.1...v0.5.2) (2026-11-18)


### Bug Fixes

* **editor:** read the draft generation after saving a version ([#292](https://github.com/honua-io/honua-studio/issues/292)) ([ce68d4e](https://github.com/honua-io/honua-studio/commit/ce68d4e7880a509fc8053e73592bf8a3bf9325f4)), closes [#291](https://github.com/honua-io/honua-studio/issues/291)

## [0.5.1](https://github.com/honua-io/honua-studio/compare/v0.5.0...v0.5.1) (2026-11-16)


### Bug Fixes

* **auth:** report an unreachable OIDC issuer as a sign-in failure, not an expired session ([#277](https://github.com/honua-io/honua-studio/issues/277)) ([1f772c7](https://github.com/honua-io/honua-studio/commit/1f772c764333dc7aa0a1ce001bd4ede34d777c25))
* **chat:** keep catalog titles and layer ids as data in the agent prompt ([7161a3e](https://github.com/honua-io/honua-studio/commit/7161a3e260aa62e71a001ea71e45bd409335392a))
* **chat:** keep catalog titles and layer ids as data in the agent prompt ([129d1c2](https://github.com/honua-io/honua-studio/commit/129d1c2e90f7a73ebaae1410a3dad89c2ef7bccf))
* **docs:** self-hosted example targets /api/v1/studio; executable docs ([#272](https://github.com/honua-io/honua-studio/issues/272)) ([884a11c](https://github.com/honua-io/honua-studio/commit/884a11c044966676843499a5d253c71ed3c465c8))
* **editor:** contain toolbar at enlarged mobile text ([#287](https://github.com/honua-io/honua-studio/issues/287)) ([038bf3c](https://github.com/honua-io/honua-studio/commit/038bf3ca06e8ce363912af1fb902c8dcf153603a))
* **processes:** fit narrow hosts and enlarged text ([#285](https://github.com/honua-io/honua-studio/issues/285)) ([112b192](https://github.com/honua-io/honua-studio/commit/112b1927f831f7fd8ac0601207007c87cef3ce1b))
* **release:** ship LICENSE and third-party notices in the Studio image ([04f1d46](https://github.com/honua-io/honua-studio/commit/04f1d46c474f7072755fa074b1e8715d7a118655))
* **release:** ship LICENSE and third-party notices in the Studio image ([4ad31df](https://github.com/honua-io/honua-studio/commit/4ad31df0726d9815bf6cb16d86cbb6ef2f923841))
* **release:** vendor missing licence texts and share the notices plugin ([2dcadd7](https://github.com/honua-io/honua-studio/commit/2dcadd7a7efab7704173432a2a3d6eb40922393c))

## [0.5.0](https://github.com/honua-io/honua-studio/compare/v0.4.0...v0.5.0) (2026-11-15)


### Features

* **styles:** mount authorized style suggestions beside the layer style editor ([#263](https://github.com/honua-io/honua-studio/issues/263)) ([df79af0](https://github.com/honua-io/honua-studio/commit/df79af07b596281d283ce38296fe97b41cb447df))


### Bug Fixes

* accept server layer indexes in the Studio catalog ([#212](https://github.com/honua-io/honua-studio/issues/212)) ([#269](https://github.com/honua-io/honua-studio/issues/269)) ([09367ed](https://github.com/honua-io/honua-studio/commit/09367edbb9fd3ef806dc7afef3d2636025c8eaf5))
* revalidate queued style suggestions and discard previews ([d8858ba](https://github.com/honua-io/honua-studio/commit/d8858ba9145cbef9ca6a068aa641c992e7030277))

## [0.4.0](https://github.com/honua-io/honua-studio/compare/v0.3.0...v0.4.0) (2026-11-14)


### ⚠ BREAKING CHANGES

* **api:** Studio's public element methods, events, host attribute, Console entry exports and the HonuaStudioWorkspace global are renamed with no deprecated aliases; CHANGELOG.md lists each old and new name. Honua Console must adopt the new names when it bumps its Studio release lock.

### Features

* **studio:** author widgets and controls without the agent ([#266](https://github.com/honua-io/honua-studio/issues/266)) ([57a35a2](https://github.com/honua-io/honua-studio/commit/57a35a2dbf96dbe649675b2df936a26cf40240bf))


### Code Refactoring

* **api:** adopt the Map, App and editor vocabulary (rename outright, no deprecated aliases) ([#236](https://github.com/honua-io/honua-studio/issues/236)) ([7a2426e](https://github.com/honua-io/honua-studio/commit/7a2426ef1ec7254f27c8b53328811c8e42eeaf0f))

## [0.3.0](https://github.com/honua-io/honua-studio/compare/v0.2.1...v0.3.0) (2026-11-14)


### Features

* **studio:** render and save public PMTiles sources ([#255](https://github.com/honua-io/honua-studio/issues/255)) ([10188cb](https://github.com/honua-io/honua-studio/commit/10188cb5690fd760ea36ed19212f60eac0a264a6))

## [0.2.1](https://github.com/honua-io/honua-studio/compare/v0.2.0...v0.2.1) (2026-11-13)


### Bug Fixes

* **smoke:** stabilize release camera and keyboard journeys ([#250](https://github.com/honua-io/honua-studio/issues/250)) ([3dc1268](https://github.com/honua-io/honua-studio/commit/3dc126824204f86fa016adf50d79470a17df4e54))

## [0.2.0](https://github.com/honua-io/honua-studio/compare/v0.1.3...v0.2.0) (2026-11-13)


### Features

* **exploration:** show and clear temporary filters where they are applied ([#130](https://github.com/honua-io/honua-studio/issues/130)) ([22e05f5](https://github.com/honua-io/honua-studio/commit/22e05f5dbfd6a143f481dfb6da422d80d587d2db))
* **lifecycle:** save keyboard feature labels on the open draft ([#227](https://github.com/honua-io/honua-studio/issues/227)) ([7e8f311](https://github.com/honua-io/honua-studio/commit/7e8f3111d198efc5ccbff5635f4b6cece951b328))
* **studio:** direct map styling, visible temporary filters, canary status (T1) ([faef3f1](https://github.com/honua-io/honua-studio/commit/faef3f1a24e714a22fd539cb96b750d2a11687cf))
* **style:** direct color, opacity, size and labels in the map style editor ([#129](https://github.com/honua-io/honua-studio/issues/129)) ([6984a5b](https://github.com/honua-io/honua-studio/commit/6984a5bd668512efea52846873d7df1b6d049c0f))


### Bug Fixes

* **auth:** support captured native Console host sessions ([#246](https://github.com/honua-io/honua-studio/issues/246)) ([65e5fbd](https://github.com/honua-io/honua-studio/commit/65e5fbd8e6cbb6e51e8ee63cb8c2c84a2bfdc303))
* **ci:** assert the worded temporary-filter label in the console-assets inspector spec ([#239](https://github.com/honua-io/honua-studio/issues/239)) ([f4b80ad](https://github.com/honua-io/honua-studio/commit/f4b80ad5d38a17e43a78a45be7246cd6619713ba))
* **ci:** open the release pull request when the bot app is not installed ([#234](https://github.com/honua-io/honua-studio/issues/234)) ([ee2df06](https://github.com/honua-io/honua-studio/commit/ee2df0655c3f533bb043afb4290139f68142bd85))
* **ci:** require App token for release PRs ([#247](https://github.com/honua-io/honua-studio/issues/247)) ([#248](https://github.com/honua-io/honua-studio/issues/248)) ([b345db0](https://github.com/honua-io/honua-studio/commit/b345db0f37f5390f8d3ae70dedbfd8026137c3f0))
* **map:** keep loaded pages when the server rate-limits a large map source ([#238](https://github.com/honua-io/honua-studio/issues/238)) ([ddf5f1c](https://github.com/honua-io/honua-studio/commit/ddf5f1c7ea16df398a4c4ec1dd696eb7beba921a))
* **map:** keep loaded pages when the server rate-limits a large map source ([#238](https://github.com/honua-io/honua-studio/issues/238)) ([42777d9](https://github.com/honua-io/honua-studio/commit/42777d9c198bd52ccc1eb913e6f926244f37f152))
* **map:** name a rate-limited metadata request too, and read only small feature bodies in the journey ([#238](https://github.com/honua-io/honua-studio/issues/238)) ([e2bf690](https://github.com/honua-io/honua-studio/commit/e2bf690e2c017284921a392a98c7444c2e15a973))
* **style, exploration:** keep unrepresentable styling intact and share filter clears ([#129](https://github.com/honua-io/honua-studio/issues/129), [#130](https://github.com/honua-io/honua-studio/issues/130)) ([9e16df6](https://github.com/honua-io/honua-studio/commit/9e16df60347aae2172c22f0289b6faa95e9c10fd))
* **style:** keep a host-opened style editor visible ([#231](https://github.com/honua-io/honua-studio/issues/231)) ([5ba4acc](https://github.com/honua-io/honua-studio/commit/5ba4accddeb0345e08662f5f9b1fc93b572d0e71))
* **style:** keep the pending-classes guard and the Labels picker current ([#129](https://github.com/honua-io/honua-studio/issues/129)) ([cdb10f4](https://github.com/honua-io/honua-studio/commit/cdb10f45ad6ff90c1e22c5d52e5d8e17ef59bbea))

## [0.1.3](https://github.com/honua-io/honua-studio/compare/v0.1.2...v0.1.3) (2026-11-10)


### Bug Fixes

* **lifecycle:** identify definitive draft creation rejections ([#222](https://github.com/honua-io/honua-studio/issues/222)) ([f099681](https://github.com/honua-io/honua-studio/commit/f099681917bf2ba9e37ab0db9e5fb25622e68699))

## [0.1.2](https://github.com/honua-io/honua-studio/compare/v0.1.1...v0.1.2) (2026-11-09)


### Bug Fixes

* **auth:** keep an in-flight read when the same principal renews its cookie ([#206](https://github.com/honua-io/honua-studio/issues/206)) ([6fcef11](https://github.com/honua-io/honua-studio/commit/6fcef11683ec8af8cc96ac29d6c724d1a21b55cf))
* **lifecycle:** preserve keyboard confirmation and gate accessibility ([#218](https://github.com/honua-io/honua-studio/issues/218)) ([98a5258](https://github.com/honua-io/honua-studio/commit/98a5258ad9e88536898f3107d5e39f3745b54329))
* **live:** exercise customer Compose approval and retain bounded evidence ([#216](https://github.com/honua-io/honua-studio/issues/216)) ([0dc3fff](https://github.com/honua-io/honua-studio/commit/0dc3fff6cfc68b4820bd30636b03fae2213524b1))
* **mcp:** use the draft writer's protocol ids in the reducer fixture ([#201](https://github.com/honua-io/honua-studio/issues/201)) ([be51adf](https://github.com/honua-io/honua-studio/commit/be51adf816925f81d4c13cc6d11b5d01481ead36))
* **shell:** keep the editor toolbar readable at phone width ([#205](https://github.com/honua-io/honua-studio/issues/205)) ([c38799e](https://github.com/honua-io/honua-studio/commit/c38799e975bd6885f66d09960e93ee948f041225))
* **workspace:** preserve New map approval handoff ([#219](https://github.com/honua-io/honua-studio/issues/219)) ([1e68d11](https://github.com/honua-io/honua-studio/commit/1e68d11baf356a36bcd0f4426db103d9eb5b26ac))
* **workspace:** save and restore the current map camera ([#203](https://github.com/honua-io/honua-studio/issues/203)) ([bf354ba](https://github.com/honua-io/honua-studio/commit/bf354bacf241c25e2b759994a05bf6a15d0163b9))

## [0.1.1](https://github.com/honua-io/honua-studio/compare/v0.1.0...v0.1.1) (2026-11-04)

Versioned Studio bundle release with published assets; consumed by Honua Console. The release run now completes; v0.1.0 published no assets.

## 0.1.0 (2026-11-04)

First versioned Studio bundle release; consumed by Honua Console.
