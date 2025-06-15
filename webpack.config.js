const path = require('path');

module.exports = {
  entry: './src/extension.ts',
  output: {
    filename: 'extension.js',
    path: path.resolve(__dirname, 'out'),
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]',
  },
  target: 'node',
  externals: {
    vscode: 'commonjs vscode', // The vscode-module is created on-the-fly and must be excluded.
    'fsevents': 'commonjs fsevents' // Exclude fsevents from the bundle
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
          },
        ],
      },
    ],
  },
  devtool: 'source-map',
};
