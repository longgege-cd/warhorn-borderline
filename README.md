# Warhorn — Borderline (战争号角-边境线)

A **territory-war Go variant** — two players deploy on their own half of a 19×19 board, establish strongholds in the opening, then score by encircling, sieging and capturing in the opponent's zone while replenishing troops on your own side.

This repository is the **web edition** (engine · server · web client) of the ruleset, currently at **v9.0**.

## Repository layout

```
├─ web/                                       # the full web app (workspace root)
├─ 《战争号角-边境线》规则书v9.0.md              # official rules (v9.0, Chinese)
├─ Warhorn-Borderline-Rules-v9.0.md           # official rules (v9.0, English)
```

## Documentation

- **Rules (v9.0, Chinese):** [`《战争号角-边境线》规则书v9.0.md`](./《战争号角-边境线》规则书v9.0.md)
- **Rules (v9.0, English):** [`Warhorn-Borderline-Rules-v9.0.md`](./Warhorn-Borderline-Rules-v9.0.md)
- **Web edition readme (build/run/tech):** see [`web/README.md`](./web/README.md)

## Getting started

Everything lives under `web/`. See [`web/README.md`](./web/README.md) for install & run instructions:

```bash
cd web
npm install
start.bat      # Windows launcher (server + client)
```

## License

Licensed under the [MIT License](./LICENSE).