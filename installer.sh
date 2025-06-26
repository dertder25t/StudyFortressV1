#!/bin/bash

# One-Line Installer for the Study App
# This script is designed to be run via curl from a fresh Debian/Ubuntu system.
# Example: curl -sL https://raw.githubusercontent.com/user/repo/main/installer.sh | sudo bash

# --- Configuration ---
# Set your GitHub repository details here.
# IMPORTANT: This script assumes it's being run from a URL and needs to clone the repo.
GITHUB_USER="YOUR_USERNAME"
REPO_NAME="study-app" # Or whatever you named your repository
REPO_URL="https://github.com/${GITHUB_USER}/${REPO_NAME}.git"
INSTALL_DIR="/opt/study-app" # The directory where the app will be installed

# --- Script Start ---
echo "--- [STUDY APP INSTALLER] Starting setup... ---"

# 1. Update system and install dependencies
echo "[1/5] Updating system and installing Git, Node.js, and npm..."
apt-get update > /dev/null
apt-get install -y git nodejs npm > /dev/null

# 2. Clone the repository
echo "[2/5] Cloning repository from ${REPO_URL}..."
git clone "${REPO_URL}" "${INSTALL_DIR}"

# Check if clone was successful
if [ ! -d "${INSTALL_DIR}" ]; then
    echo "ERROR: Failed to clone the repository. Please check the URL and permissions."
    exit 1
fi

cd "${INSTALL_DIR}/backend"

# 3. Install Node.js backend dependencies
echo "[3/5] Installing backend dependencies with npm..."
npm install

# 4. Install and configure PM2 (Process Manager for Node.js)
echo "[4/5] Installing PM2 to keep the server running..."
npm install pm2 -g

echo "--- Configuring PM2 to start the app on boot... ---"
# This is a bit of magic. It generates and runs a command to set up the startup service.
pm2 start server.js --name study-app
pm2 save
env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u $(whoami) --hp /home/$(whoami)

# 5. Final output
echo "[5/5] All done!"
echo "----------------------------------------------------"
echo "✅ Study App Installation Complete"
echo ""
echo "The application server is now running via PM2."
echo "You can access it at: http://<your_server_ip>:3000"
echo ""
echo "Useful PM2 commands:"
echo "  pm2 list        - List running applications"
echo "  pm2 logs        - View application logs in real-time"
echo "  pm2 restart all - Restart the application"
echo "----------------------------------------------------"

