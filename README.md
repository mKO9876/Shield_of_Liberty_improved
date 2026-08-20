# ML Content Blocker

An experimental content blocker that uses a machine learning model (Random Forest) instead of traditional filter lists to detect and block unwanted content (ads, trackers, etc.) in web pages.

Instead of relying on manually curated filter lists, this project trains a classifier on features extracted from a page's DOM structure (as a graph), network requests, and network responses. The filter lists themselves were used only as the source of ground-truth labels for training data, so the model's effectiveness could be compared against the very lists it learned from.

## Motivation

The goal of this project was to answer a simple question: can a machine learning model detect and block unwanted content as well as, or better than, a traditional filter list?

To find out, the same features used to build filter lists (DOM structure, network requests, network responses) were extracted and used to train several classifiers. Random Forest produced the best results among the models tested.

## Project Structure

The repository is organized into four main parts:

### 1. Scraper (Puppeteer)

A Node.js scraper built with Puppeteer that visits websites and collects raw training data: DOM structure, network requests, and network responses. This data is later labeled using filter lists and used to train the machine learning models.

### 2. Python Environment (Data Preparation & Model Training)

A Python environment used to:
- Clean and prepare the raw scraped data
- Engineer features from DOM graphs and network data
- Train and evaluate multiple machine learning models
- Compare model performance and select the best candidate (Random Forest)

This environment was used purely for experimentation and model selection, and is not part of the runtime pipeline.

### 3. Browser Extension

A Chromium-based browser extension that:
- Collects DOM and network data from web pages as they load, using the same approach as the scraper
- Sends this data to the Flask API for prediction
- Applies blocking rules based on the model's predictions

The extension is tab-optimized: each tab maintains its own rule list, which is cleared whenever the tab navigates to a new page or is closed. This avoids memory buildup and prevents crashes that can occur when rule lists grow unbounded across tabs.

### 4. Flask API

A Flask API, designed to run inside Docker, that:
- Receives raw data collected by the extension
- Prepares and transforms the data using the same logic as the Python training environment
- Runs the trained Random Forest model to classify content
- Returns predictions to the extension

## Design Philosophy

The same two-language split is used throughout the project:
- JavaScript (Puppeteer / extension) is responsible for collecting data
- Python (training environment / Flask API) is responsible for preparing data and running the model

This keeps data collection and data preparation logic consistent between the training pipeline and the live prediction pipeline.

## Results and Limitations

The project was evaluated on two fronts: detection accuracy in a live environment, and impact on page load speed.

The Random Forest model achieved good detection accuracy (around 90%) when tested live. However, the overall architecture revealed a fundamental limitation: because the model relies on DOM graph and network data to make predictions, it needs the page to fully load before it can classify content. As a result, the model cannot intervene in real time to block requests before they happen.

This means that even with high detection accuracy, this architecture is not well suited for blocking unwanted content in practice. A model can correctly identify unwanted content after the fact, but by the time it has enough data to do so, that content has usually already loaded. Traditional filter lists remain more effective for actual blocking, since they can prevent requests before they are made, without needing to observe the full page first.

## Conclusion

This project demonstrates that a machine learning model can detect unwanted content with accuracy comparable to filter lists, but that detection accuracy alone does not make for an effective content blocker. Blocking requires stopping content before it loads, and this architecture's dependency on full DOM and network data makes that impossible. The project is best viewed as a research experiment into ML-based content classification rather than a production-ready blocking solution.
