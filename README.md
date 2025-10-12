# Zen-Tidy-Downloads

![image](https://github.com/Anoms12/Zen-Tidy-Downloads/blob/main/image.png?raw=true)

**Rename your downloads with ease, and do it in style!**

## Features
* AI renaming with Gemini AI
* Undo button if when you don't like the name

That's all, your just downloading a file. _What did you expect?_

## Setup

1. Get a Gemini API key from [Google AI Studio](https://makersuite.google.com/app/apikey)
2. In Firefox, go to `about:config` and set:
   - `extensions.downloads.gemini_api_key` to your API key
   - `extensions.downloads.gemini_model` to your preferred model (default: gemini-2.5-flash-lite)
   
   Available models:
   - `gemini-2.5-flash` - Latest Gemini 2.5 Flash model
   - `gemini-2.5-flash-preview-09-2025` - Preview version of Gemini 2.5 Flash
   - `gemini-2.5-flash-lite` - Fast, lightweight version of Gemini 2.5 Flash
   - `gemini-2.5-flash-lite-preview-09-2025` - Preview of the lite version
   - `gemini-2.0-flash` - Gemini 2.0 Flash model
   - `gemini-2.0-flash-lite` - Fast, lightweight version of Gemini 2.0 Flash
3. Restart Firefox or reload the userChrome scripts
