// Metro doesn't need this (its own config handles the app build), but Jest
// does — this is the one config file Jest reads to transform TS/JSX.
module.exports = {
  presets: ["babel-preset-expo"],
};
