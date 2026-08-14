# C Repair Leaderboard

Measured comparisons of how well LLM systems repair C secure-coding violations, and at what cost.

## Live leaderboard

**[Open the CERT-C Repair Leaderboard →](https://safe-c-ai.github.io/c-repair-leaderboard/cert-c/)**

115 CERT-C Rules, one Medium-difficulty case each. (Site source: [`cert-c/`](cert-c/))

Scores are measurements of frozen System configurations (model + provider + settings) on a
private evaluation pack — not correctness guarantees and not model-general performance.
See the FAQ on the leaderboard page for scope, method, and known limits.

Measurement harness: [CertFix](https://github.com/safe-c-ai/certfix).

## License

- Code (HTML / CSS / JS): [MIT](LICENSE)
- Data files under `cert-c/data/`: [CC BY 4.0](cert-c/data/LICENSE) (sanitized aggregate measurements only)

Model and company names are trademarks of their respective owners. This leaderboard is
independent and is not endorsed by or affiliated with any listed provider.
