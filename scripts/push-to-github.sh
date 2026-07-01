#!/bin/bash

# Ping AI Agents Demo — GitHub Push Instructions
# ================================================

# This script automates pushing the local repo to GitHub

set -e

GITHUB_USER="${1:-tarunmadiraju}"
REPO_NAME="${2:-pingfederate-ai-agents-demo}"
REPO_URL="https://github.com/$GITHUB_USER/$REPO_NAME"

echo "📤 Setting up GitHub remote..."
echo ""

# Check if git is initialized
if [ ! -d .git ]; then
    echo "❌ Not a git repository. Run 'git init' first."
    exit 1
fi

# Add remote
echo "Adding remote: $REPO_URL"
git remote add origin "$REPO_URL" 2>/dev/null || git remote set-url origin "$REPO_URL"

# Check GitHub credentials
echo ""
echo "🔐 Checking GitHub authentication..."
if ! gh auth status &> /dev/null; then
    echo "❌ GitHub CLI not authenticated. Run: gh auth login"
    exit 1
fi
echo "✅ Authenticated with GitHub"

# Create repository (if using gh CLI)
echo ""
echo "📦 Creating remote repository..."
if gh repo view "$GITHUB_USER/$REPO_NAME" &> /dev/null; then
    echo "  Repository already exists"
else
    gh repo create "$REPO_NAME" \
        --public \
        --description "Ping Identity AI Agents Demo — Enterprise-ready AI with identity security" \
        --homepage "https://github.com/$GITHUB_USER/$REPO_NAME" \
        --remote origin \
        --source=. \
        --remote-name origin \
        --push
    echo "✅ Repository created"
fi

# Push to GitHub
echo ""
echo "📤 Pushing to GitHub..."
git branch -M main
git push -u origin main

echo ""
echo "================================="
echo "🎉 Success!"
echo "================================="
echo ""
echo "📍 Repository URL:"
echo "   $REPO_URL"
echo ""
echo "📖 Next Steps:"
echo "   1. Fork: github.com/$GITHUB_USER/$REPO_NAME"
echo "   2. Clone: git clone $REPO_URL"
echo "   3. Deploy: make setup"
echo ""
