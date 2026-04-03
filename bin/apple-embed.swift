#!/usr/bin/env swift
// Apple NaturalLanguage Embedding Helper
// Part of setup-claude-memory — generates sentence embeddings using macOS built-in ML
// Usage: echo "some text" | swift apple-embed.swift
// Output: JSON array of floats to stdout

import Foundation
import NaturalLanguage

// Read text from stdin
let input = readLine(strippingNewline: true) ?? ""
guard !input.isEmpty else {
    fputs("Error: empty input\n", stderr)
    exit(1)
}

// Use sentence embedding (built into macOS 14+)
guard let embedding = NLEmbedding.sentenceEmbedding(for: .english) else {
    fputs("Error: sentence embedding model not available\n", stderr)
    exit(1)
}

guard let vector = embedding.vector(for: input) else {
    fputs("Error: could not generate embedding for input\n", stderr)
    exit(1)
}

// Output as JSON array
let jsonArray = vector.map { String($0) }.joined(separator: ",")
print("[\(jsonArray)]")
