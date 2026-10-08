# Playground and GitHub Pages

The static site keeps documentation and the Playground in one GitHub Pages
deployment:

- Documentation: <https://mors119.github.io/copc-adapter/>
- Korean documentation: <https://mors119.github.io/copc-adapter/ko/>
- Interactive Playground: <https://mors119.github.io/copc-adapter/playground/>

The VitePress site owns the repository Pages root. The Playground is built for
the nested `/copc-adapter/playground/` base and is assembled into the same
artifact under `playground/`; deploying either site therefore retains the
other.

For Playground setup, development, package-candidate builds, and local Pages
validation, see the [Playground README](https://github.com/mors119/copc-adapter/blob/main/apps/playground/README.md).
