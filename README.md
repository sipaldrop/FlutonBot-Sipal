# Sipal FlutonBot

![Sipal Drop](https://img.shields.io/badge/SIPALDROP-ACTIVATED-blue?style=for-the-badge)

Automated bot for Fluton interactions, designated for Sipal Airdrop operations.

## Features

- **Automated Login & Auth**: Handles wallet authentication seamlessly.
- **Daily Check-ins**: Automatically performs daily check-ins.
- **Task Management**: Completes social tasks and other automated activities.
- **Robust Retry Logic**: Built-in mechanisms to handle network instability.
- **Multi-Account Support**: Loop through multiple accounts efficiently.

## Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/sipaldrop/FlutonBot-Sipal.git
    cd FlutonBot-Sipal
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Setup Configuration:**
    - Rename `accounts_template.json` to `accounts.json`.
    - Edit `accounts.json` and add your private keys and proxies.

    ```json
    [
        {
            "privateKey": "YOUR_PRIVATE_KEY_HERE",
            "proxy": "http://user:pass@host:port" 
        }
    ]
    ```
    *(Leave proxy empty `""` if not using one)*

## Usage

Run the bot:

```bash
node index.js
```

## Disclaimer

This tool is for educational purposes only. Use it at your own risk. Sipal Drop is not responsible for any bans or penalties directly or indirectly resulting from the use of this tool.
