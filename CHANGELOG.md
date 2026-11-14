# Changelog

## [0.4.0](https://github.com/honua-io/honua-studio/compare/v0.3.0...v0.4.0) (2026-11-14)


### ⚠ BREAKING CHANGES

* **api:** Studio's public element methods, events, host attribute, Console entry exports and the HonuaStudioWorkspace global are renamed with no deprecated aliases; CHANGELOG.md lists each old and new name. Honua Console must adopt the new names when it bumps its Studio release lock.

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
