// A command-line tool to manage admin users for the Study Fortress app.
// Usage: node admin-tool.js <command> <email>
//
// Commands:
//   list           - Lists all users and their admin status.
//   grant <email>  - Grants admin privileges to the user with the specified email.
//   revoke <email> - Revokes admin privileges from the user with the specified email.

const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const dbFile = './database.db';

async function main() {
    const command = process.argv[2];
    const email = process.argv[3];

    const db = await open({
        filename: dbFile,
        driver: sqlite3.Database
    });

    switch (command) {
        case 'list':
            console.log("--- User List ---");
            const users = await db.all('SELECT id, email, isAdmin FROM users');
            if (users.length === 0) {
                console.log("No users found.");
            } else {
                users.forEach(user => {
                    console.log(`ID: ${user.id}, Email: ${user.email}, Admin: ${user.isAdmin ? 'Yes' : 'No'}`);
                });
            }
            break;

        case 'grant':
            if (!email) {
                console.error("Error: Please provide an email address. Usage: node admin-tool.js grant user@example.com");
                break;
            }
            try {
                const result = await db.run('UPDATE users SET isAdmin = 1 WHERE email = ?', email);
                if (result.changes === 0) {
                    console.log(`No user found with email: ${email}`);
                } else {
                    console.log(`Admin privileges granted to ${email}`);
                }
            } catch (error) {
                console.error("Failed to grant admin privileges:", error);
            }
            break;

        case 'revoke':
            if (!email) {
                console.error("Error: Please provide an email address. Usage: node admin-tool.js revoke user@example.com");
                break;
            }
            try {
                const result = await db.run('UPDATE users SET isAdmin = 0 WHERE email = ?', email);
                if (result.changes === 0) {
                    console.log(`No user found with email: ${email}`);
                } else {
                    console.log(`Admin privileges revoked for ${email}`);
                }
            } catch (error) {
                console.error("Failed to revoke admin privileges:", error);
            }
            break;

        default:
            console.log("Unknown command. Available commands: list, grant, revoke");
            break;
    }

    await db.close();
}

main().catch(err => {
    console.error("An unexpected error occurred:", err);
});
