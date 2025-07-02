# Study Fortress V1

**A self-hosted, AI-powered flashcard and note-taking application designed for ultimate control and privacy.**

Study Fortress is a full-stack web application that allows you to create folders, take rich-text notes, and generate flashcards manually or automatically using multiple AI providers. It includes advanced features like PDF/book integration, an in-app update mechanism for administrators, and a secure command-line tool for user management.

## Features

- **Self-Hosted:** Runs on your own server for complete data privacy. No external database dependencies.
- **Folder Organization:** Group your notes and cards into color-coded folders.
- **Rich Note-Taking:** A "Notes Lab" with a full-featured text editor and a side-by-side flashcard manager.
- **Multi-Provider AI:**
    - Generate flashcards from your notes using Google AI, OpenAI, or Hugging Face.
    - Generate sub-points and highlight keywords in your notes.
- **Book & Document Mode:** Upload PDFs directly into your study folders and view them alongside your notes.
- **Voice Memos:** Record and attach audio clips to your notes.
- **Admin Panel:** A secure, in-app dashboard for administrators to update the application directly from the UI.
- **Command-Line Tools:** Securely manage admin users from the server console.

---

## Installation

These instructions are for a Debian-based Linux distribution (like Ubuntu or Debian itself).

1.  **Clone the Repository:**
    Log into your server and clone the project into the `/opt` directory.
    ```bash
    sudo git clone [https://github.com/dertder25t/StudyFortressV1.git](https://github.com/dertder25t/StudyFortressV1.git) /opt/StudyFortressV1
    ```

2.  **Run the Installer:**
    The installer script will set up Node.js, PM2 (a process manager), and all necessary dependencies.
    ```bash
    cd /opt/StudyFortressV1
    sudo chmod +x installer.sh
    sudo ./installer.sh
    ```
    The installer will start the application automatically. You can access it at `http://<your_server_ip>:3000`.

---

## Post-Installation Setup: Creating an Admin

The application does not have a default admin. You must grant admin privileges manually for security.

1.  **Create Your User Account:**
    Go to the application in your browser and **Sign Up** for a new account with the email you want to use for administration.

2.  **Grant Admin Privileges:**
    On your server's command line, navigate to the backend directory:
    ```bash
    cd /opt/StudyFortressV1/backend
    ```
    Run the admin tool to promote your new user:
    ```bash
    node admin-tool.js grant your-email@example.com
    ```
    *(Replace with the email you just registered).*

3.  **Log In:**
    Go back to the app in your browser, log out if you were still logged in, and then **log back in**. The "Admin Controls" panel will now appear in your Profile & Settings page.

---

## Application Management

We use **PM2** to keep the application running as a background service. Here are the essential commands to manage it.

* **List Running Apps:**
    ```bash
    sudo pm2 list
    ```

* **View Live Logs:**
    This is the most important command for debugging. It shows the live console output from the server.
    ```bash
    sudo pm2 logs study-app
    ```

* **Restart the App:**
    Use this after pulling updates from GitHub.
    ```bash
    sudo pm2 restart study-app
    ```

* **Stop the App:**
    ```bash
    sudo pm2 stop study-app
    ```

* **Enable Automatic Startup on Reboot:**
    This command ensures PM2 starts automatically whenever the server reboots. You only need to run this once.
    ```bash
    sudo pm2 startup
    ```
    (You may be asked to copy and paste a command to finalize the setup).

---

## Updating the Application

There are two ways to update your Study Fortress instance.

### 1. The Admin Panel (Recommended)

As an admin user, you can navigate to `Profile & Settings` -> `Application` and click the **"Check for Updates"** button. If a new version is detected on GitHub, the **"Update Now"** button in the "Admin Controls" section will become your primary method for updating. Clicking it will automatically pull the latest code and restart the server, with a log of the process shown in a modal.

### 2. Manual Update (via Command Line)

If you prefer, or if the in-app update fails, you can update the app manually from the server's command line.

1.  **Navigate to the app directory:**
    ```bash
    cd /opt/StudyFortressV1
    ```
2.  **Pull the latest code from GitHub:**
    ```bash
    sudo git pull
    ```
3.  **Install any new dependencies:**
    ```bash
    sudo npm install --prefix backend
    ```
4.  **Restart the application with PM2:**
    ```bash
    sudo pm2 restart study-app
    ```

---

## Admin Tool Usage

The `admin-tool.js` script is a powerful, secure way to manage user permissions. Always run it from the `backend` directory.

**Location:** `/opt/StudyFortressV1/backend/`

**Usage:** `node admin-tool.js <command> [email]`

### Commands

* **List All Users:**
    Shows every user and their current admin status.
    ```bash
    node admin-tool.js list
    ```

* **Grant Admin Privileges:**
    Promotes a standard user to an admin.
    ```bash
    node admin-tool.js grant user@example.com
    ```

* **Revoke Admin Privileges:**
    Demotes an admin back to a standard user.
    ```bash
    node admin-tool.js revoke user@example.com
    ```
