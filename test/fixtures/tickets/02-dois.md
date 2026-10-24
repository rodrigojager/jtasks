# 02: Acquire e release atômicos

**What to build:** `acquire` e `release` com criação atômica de arquivo.

**Blocked by:** 01

**Status:** ready-for-agent

**Files:** `src/cmd/acquire.rs`, `src/cmd/release.rs`, `tests/race.rs`

- [ ] dois pedidos simultâneos: só um vence
- [ ] `release` só pelo dono

**Scope boundary:** a fila vem no 03.
