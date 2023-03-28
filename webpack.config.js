const path = require('path')
const TerserPlugin = require('terser-webpack-plugin')

module.exports = {
  entry: './src/signaling.ts',
  output: {
    library: 'api',
    libraryTarget: 'umd',
    umdNamedDefine: true,
    path: path.resolve(__dirname, 'dist'),
    filename: 'signaling.js',
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js'],
    modules: ['node_modules'],
  },
  target: 'node',
  mode: 'production',
  ignoreWarnings: [/^(?!CriticalDependenciesWarning$)/],
  module: {
    rules: [
      {
        // all files with a `.ts` or `.tsx` extension will be handled by `ts-loader`
        test: /\.tsx?$/,
        use: [
          {
            loader: 'ts-loader',
          },
        ],
      },
      {
        // all files with a `.html` or `.txt` extension will be treated as raw
        // https://webpack.js.org/guides/asset-modules/#source-assets
        test: /\.(html|txt)$/,
        type: 'asset/source',
      },
    ],
  },
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          format: {
            comments: false,
          },
        },
        extractComments: false,
      }),
    ],
  },
}
