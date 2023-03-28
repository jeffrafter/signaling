const dotenv = require('dotenv')
dotenv.config()

require('./raw-loader.js')

module.exports = {
  clearMocks: true,
  moduleFileExtensions: ['js', 'ts'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleNameMapper: {
    '\\.(html|txt)$': 'identity-obj-proxy',
  },
  preset: 'jest-dynalite',
  verbose: true,
}
