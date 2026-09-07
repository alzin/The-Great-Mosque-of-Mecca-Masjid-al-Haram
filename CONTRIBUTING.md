# Contributing

Contributions are welcome: bug reports, accessibility improvements, performance
work, documentation, and improvements to the simulation.

## Report a bug or propose a change

Use [GitHub Issues](https://github.com/alzin/The-Great-Mosque-of-Mecca-Masjid-al-Haram/issues).
For bugs, include steps to reproduce, expected and actual behaviour, and your
browser and device. Screenshots or a short recording help with visual issues.
For large changes, open an issue first so we can agree on the scope.

## Make a contribution

1. Fork the repository and create a branch for your change.
2. Run `npm ci`, then `npm run dev` to start the local preview.
3. Keep changes focused and update relevant documentation.
4. Run `npm run build` and tests relevant to your change. Run `npm test` for
   simulation changes; use `npm run soak` when changing long-running crowd
   behaviour. For interface changes, check desktop and mobile layouts;
   `npm run qa:mobile` provides additional checks with Playwright installed.
5. Open a pull request explaining the problem, the change, and how you checked it.
   Include screenshots for visible changes and link related issues.

See [README.md](README.md) for setup and controls, and
[ARCHITECTURE.md](ARCHITECTURE.md) for the structure of the project.

## Audio, assets, and accuracy

Preserve the distinction between the simulated scene and real recordings.
Keep the audio controls accessible and respect a listener's pause choice.
Document sources and usage terms for any new third-party material in
[ASSETS.md](ASSETS.md). Do not assume the project's MIT license covers recordings,
dependencies, or other material owned by third parties.

## License

By submitting a contribution, you agree to license your contribution under the
project's [MIT License](LICENSE). Only contribute material you have the right to share.
