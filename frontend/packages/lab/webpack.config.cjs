/** Stable IDs make prebuilt extension filenames reproducible across clean roots. */
module.exports = {
  optimization: {
    moduleIds: 'named',
    chunkIds: 'deterministic',
  },
};
