# Security

The node runs on machines its users own, and subs.rocks treats it as untrusted: it's given a render's files for that render alone, with a token that ends when the render does (see *What it sees* in the [README](./README.md)). A way around that, for a node to reach what isn't its render's or another workspace's, or for anyone to act as a node they don't run, is a vulnerability we want to hear about.

**Report it privately:** with GitHub's private vulnerability reporting on this repository (*Security › Report a vulnerability*), or by mail to team@subs.rocks. Please don't open a public issue for it. Tell us what you found and how to see it; we answer within three working days and say what we'll do.

Only the latest release is supported: fixes are released as a new version, which every node should update to.
