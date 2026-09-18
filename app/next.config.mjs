/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { webpack }) => {
    // The Solana libraries were written for Node and reach for the Buffer
    // global, which browsers do not have and Next does not provide. This app's
    // own code avoids it, but anchor's borsh coder does not, so the global has
    // to exist for the bundle to run at all.
    //
    // The webpack instance comes from Next rather than from an import: webpack
    // is not a direct dependency here, it is the one Next already bundles, and
    // importing a second copy is how you get two incompatible plugin classes.
    config.plugins.push(
      new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"] }),
    );
    config.resolve.fallback = {
      ...config.resolve.fallback,
      buffer: "buffer",
      crypto: false,
      stream: false,
      fs: false,
      path: false,
    };
    return config;
  },
};

export default nextConfig;
