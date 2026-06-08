# Article Build Design Summary

## Introduction

This skill is a self-contained article regeneration subsystem. It converts article-owned planning material into validated HTML without depending on host-project code outside the skill folder.

## Core Content

The skill resolves an article root, reads chapter plans, expands generated chapter templates, copies and validates SVG assets, checks bibliography support, and regenerates the final HTML only when inputs are newer than outputs. The bibliography subsystem caches evidence under the article plan directory, and the HTML renderer preserves citation links, figures, tables, and a print-oriented export control. All executable logic lives in modules inside this folder.

## Conclusion

Future revisions must keep the article build pipeline deterministic, incremental, and self-contained. If the workflow changes, the descriptor, the module set, and the test fixtures must be updated together.
