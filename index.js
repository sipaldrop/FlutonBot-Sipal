const fs = require('fs');
const chalk = require('chalk');
const { ethers } = require('ethers');
const Table = require('cli-table3');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fakeUserAgent = require('fake-useragent');
const axios = require('axios');

// --- CONFIGURATION ---
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const accounts = JSON.parse(fs.readFileSync('accounts.json', 'utf8'));

const PAYMENT_ADDRESSES = [
    "0x901c9F2F577baedDfBa341205fbe9692c2aE0559",
    "0xe1d742e039aea02402b2d864b70ea55b5e0f3e79",
    "0xF595fC9d4ee3a37383A4e52dF52b229ACE9A463C",
    "0x84e9F482Fc778D2Efed9a83e8c607f4cDc1CDFf0",
    "0x9433e83af032235b5eb9a8476f4d39a920475bb9"
];

// --- ABIS ---
const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

const FAUCET_ABI = [
    "function drip(address token) external",
    "function faucet(address token) external",
    "function claim() external"
];

const BRIDGE_ABI = [
    "function deposit(address token, uint256 amount) external",
    "function shield(address token, uint256 amount) external",
    "function wrap(address to, uint256 amount) external"
];

// --- LOGGING HELPER ---
const STYLES = {
    header: chalk.bold.cyan,
    success: chalk.green,
    error: chalk.red,
    warn: chalk.yellow,
    info: chalk.blue,
    check: chalk.magentaBright,
    timestamp: chalk.gray
};

function log(accountIndex, type, message) {
    const timestamp = new Date().toLocaleTimeString();
    const accountStr = accountIndex !== null ? `[Acc ${accountIndex + 1}]` : '[System]';

    let prefix = '';
    let colorFn = STYLES.info;

    switch (type) {
        case 'INFO': prefix = 'ℹ'; colorFn = STYLES.info; break;
        case 'SUCCESS': prefix = '✅'; colorFn = STYLES.success; break;
        case 'ERROR': prefix = '❌'; colorFn = STYLES.error; break;
        case 'WARN': prefix = '⚠️'; colorFn = STYLES.warn; break;
        case 'CHECK': prefix = '🔍'; colorFn = STYLES.check; break;
    }

    console.log(`${STYLES.timestamp(timestamp)} ${chalk.bold(accountStr)} ${prefix} ${colorFn(message)}`);
}

// --- UTILS ---
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

// --- DISPLAY ---
function displayBanner() {
    console.clear();
    console.log(chalk.blue(`
               / \\
              /   \\
             |  |  |
             |  |  |
              \\  \\
             |  |  |
             |  |  |
              \\   /
               \\ /
    `));
    console.log(chalk.bold.cyan('    ======SIPAL AIRDROP======'));
    console.log(chalk.bold.cyan('  =====SIPAL FLUTON BOT V1.0====='));
    console.log('\n');
}

function displayGrandSummary(stats) {
    console.log('\n' + chalk.bold.cyan('================================================================================'));
    console.log(chalk.bold.cyan(`                          🤖 SIPAL FLUTON BOT V1.0 🤖`));
    console.log(chalk.bold.cyan('================================================================================'));

    const table = new Table({
        head: ['Account', 'Address', 'Balance', 'Actions', 'Status'],
        style: { head: ['cyan'], border: ['grey'] },
        colWidths: [10, 20, 15, 10, 20]
    });

    stats.forEach(s => {
        table.push([
            `Acc ${s.index + 1}`,
            s.address ? `${s.address.substring(0, 6)}...${s.address.substring(38)}` : 'N/A',
            s.balance ? `${s.balance} ETH` : '0 ETH',
            s.actions || 0,
            s.status || 'Idle'
        ]);
    });

    console.log(table.toString());
    console.log(chalk.bold.cyan('================================================================================\n'));
}

// --- CORE LOGIC ---
class FlutonAccount {
    constructor(accountConfig, index) {
        this.config = accountConfig;
        this.index = index;
        this.wallet = null;
        this.provider = null;
        this.stats = {
            index: index,
            address: null,
            balance: null,
            network: 'Initializing',
            actions: 0,
            status: 'Initializing'
        };
        this.currentNetworkKey = 'sepolia';
    }

    async checkIp() {
        if (!this.config.proxy) return;
        try {
            const agent = new HttpsProxyAgent(this.config.proxy);
            const response = await axios.get('https://api.ipify.org?format=json', {
                headers: { 'User-Agent': fakeUserAgent() },
                httpAgent: agent,
                httpsAgent: agent,
                timeout: 5000
            });
            log(this.index, 'SUCCESS', `Proxy Check: ${response.data.ip}`);
        } catch (error) {
            log(this.index, 'WARN', `Proxy/IP check failed, continuing...`);
        }
    }

    async switchNetwork(networkKey) {
        try {
            this.currentNetworkKey = networkKey;
            const netConfig = config.networks[networkKey];
            this.stats.network = netConfig.name;
            this.stats.status = `Switching to ${netConfig.name}`;

            this.provider = new ethers.JsonRpcProvider(netConfig.rpcUrl);
            this.wallet = new ethers.Wallet(this.config.privateKey, this.provider);
            this.stats.address = this.wallet.address;

            const balance = await this.provider.getBalance(this.wallet.address);
            this.stats.balance = parseFloat(ethers.formatEther(balance)).toFixed(4);

            log(this.index, 'CHECK', `Switched to ${netConfig.name} | Balance: ${this.stats.balance} ETH`);
            return true;
        } catch (error) {
            log(this.index, 'ERROR', `Failed to switch to ${networkKey}: ${error.message}`);
            return false;
        }
    }

    async tryTransaction(description, txPromise, silent = false) {
        try {
            if (!silent) log(this.index, 'INFO', `Executing: ${description}...`);
            const tx = await txPromise;
            await tx.wait();
            log(this.index, 'SUCCESS', `${description} Confirmed`);
            this.stats.actions++;
            return true;
        } catch (error) {
            // Check for nonce issues or replacements
            const isNonceIssue = error.message.includes('nonce') || error.code === 'NONCE_EXPIRED' || error.code === 'REPLACEMENT_UNDERPRICED';

            // If it was a silent try (fallback), just wait a bit and return false
            if (silent) {
                // If it reverted on-chain, it consumed a nonce, so we must wait for propagation
                if (error.receipt || isNonceIssue) {
                    await sleep(3000);
                }
                return false;
            }

            // For non-silent errors, cleaner logging
            let cleanMsg = error.reason || error.shortMessage || error.message;
            if (cleanMsg.length > 100) cleanMsg = cleanMsg.substring(0, 100) + '...';

            log(this.index, 'ERROR', `${description} Failed: ${cleanMsg}`);

            if (isNonceIssue) {
                log(this.index, 'WARN', 'Nonce desync detected. Waiting 5s to realign...');
                await sleep(5000);
            }
            return false;
        }
    }

    async interactFaucet() {
        const netConfig = config.networks[this.currentNetworkKey];
        if (!netConfig.contracts.faucet || !netConfig.tokens) return;

        const faucetAddr = ethers.getAddress(netConfig.contracts.faucet);
        const faucetContract = new ethers.Contract(faucetAddr, FAUCET_ABI, this.wallet);

        for (const [symbol, tokenAddrRaw] of Object.entries(netConfig.tokens)) {
            try {
                const tokenAddr = ethers.getAddress(tokenAddrRaw);
                const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, this.wallet);
                const balance = await tokenContract.balanceOf(this.wallet.address);

                if (balance === 0n) {
                    log(this.index, 'CHECK', `Zero balance for ${symbol}. Attempting Faucet...`);
                    try {
                        await this.tryTransaction(`Faucet Drip ${symbol}`, faucetContract.drip(tokenAddr));
                    } catch (e) {
                        try {
                            await this.tryTransaction(`Faucet Claim ${symbol}`, faucetContract.faucet(tokenAddr));
                        } catch (e2) { }
                    }
                    await sleep(2000);
                }
            } catch (e) { }
        }
    }

    async interactTokens() {
        const netConfig = config.networks[this.currentNetworkKey];
        if (!netConfig.tokens) return;

        const bridgeAddr = netConfig.contracts.cofheBridge ? ethers.getAddress(netConfig.contracts.cofheBridge) : null;
        let bridgeContract = null;
        if (bridgeAddr) bridgeContract = new ethers.Contract(bridgeAddr, BRIDGE_ABI, this.wallet);

        for (const [symbol, tokenAddrRaw] of Object.entries(netConfig.tokens)) {
            try {
                const tokenAddr = ethers.getAddress(tokenAddrRaw);
                const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, this.wallet);
                const balance = await tokenContract.balanceOf(this.wallet.address);
                const readableBalance = ethers.formatUnits(balance, 6);

                log(this.index, 'INFO', `Token ${symbol}: ${readableBalance}`);

                if (balance > 0n) {
                    // --- TASK 1: PAYMENT (Randomized) ---
                    // Smart Saving: 0.01% of balance
                    const paymentAmount = balance / 10000n;

                    if (paymentAmount > 0n) {
                        const randomRecipient = PAYMENT_ADDRESSES[Math.floor(Math.random() * PAYMENT_ADDRESSES.length)];
                        await this.tryTransaction(`Payment ${symbol} to ${randomRecipient.substring(0, 6)}...`, tokenContract.transfer(randomRecipient, paymentAmount));
                        await sleep(1000);
                    }

                    // --- TASK 2: SHIELD (Bridge) ---
                    if (bridgeContract) {
                        // Shield 1-5%
                        const percent = BigInt(Math.floor(Math.random() * 5) + 1);
                        const shieldAmount = (balance * percent) / 100n;

                        if (shieldAmount > 0n) {
                            const allowance = await tokenContract.allowance(this.wallet.address, bridgeAddr);
                            if (allowance < shieldAmount) {
                                await this.tryTransaction(`Approve ${symbol}`, tokenContract.approve(bridgeAddr, ethers.MaxUint256));
                            }

                            // Try Shield (using deposit or shield func)
                            const txConfig = { gasLimit: 500000 };
                            let success = false;

                            try {
                                success = await this.tryTransaction(`Deposit ${symbol} (${percent}%)`, bridgeContract.deposit(tokenAddr, shieldAmount, txConfig), true);
                            } catch (e) { }

                            if (!success) {
                                try {
                                    success = await this.tryTransaction(`Shield ${symbol} (${percent}%)`, bridgeContract.shield(tokenAddr, shieldAmount, txConfig), true);
                                } catch (e) { }
                            }

                            if (!success) {
                                // Base Sepolia uses wrap(to, amount)
                                try {
                                    success = await this.tryTransaction(`Wrap ${symbol} (${percent}%)`, bridgeContract.wrap(this.wallet.address, shieldAmount, txConfig), true);
                                } catch (e) { /* Method might not exist in object if ABI mismatch, but we added it */ }
                            }

                            if (!success) {
                                // Arbitrum Sepolia might just need transfer to bridge
                                success = await this.tryTransaction(`Transfer to Bridge ${symbol} (${percent}%)`, tokenContract.transfer(bridgeAddr, shieldAmount, txConfig));
                            }
                        }
                    }

                    // --- TASK 3: SWAP (Simulation via Self Transfer) ---
                    const swapAmount = balance / 5000n;
                    await this.tryTransaction(`Swap Activity (Sim) ${symbol}`, tokenContract.transfer(this.wallet.address, swapAmount));
                }
            } catch (error) {
                // log(this.index, 'WARN', `Skipping ${symbol}: ${error.message}`);
            }
        }
    }

    async runRoutine() {
        this.stats.status = 'Running';
        await this.checkIp();

        const networks = ['base_sepolia', 'sepolia', 'arbitrum_sepolia'];

        for (const netKey of networks) {
            if (await this.switchNetwork(netKey)) {
                await this.interactFaucet();
                await this.interactTokens();
                await sleep(getRandomDelay(3, 5));
            }
        }

        log(this.index, 'SUCCESS', `Routine Finished.`);
        this.stats.status = 'Completed';
    }
}

async function main() {
    const botAccounts = accounts.map((acc, idx) => new FlutonAccount(acc, idx));
    displayBanner();

    while (true) {
        for (const acc of botAccounts) {
            await acc.runRoutine();
            const delay = getRandomDelay(5, 8);
            log(null, 'INFO', `Waiting ${delay / 1000}s...`);
            await sleep(delay);
        }

        // --- END OF CYCLE ---
        displayGrandSummary(botAccounts.map(a => a.stats));

        log(null, 'SUCCESS', 'Daily Cycle Completed. Sleeping for 24 HOURS...');
        const hours = 24;
        for (let i = 0; i < hours; i++) {
            await sleep(60 * 60 * 1000);
            // log(null, 'INFO', `Sleeping... ${i+1}/${hours} hours passed.`);
        }

        // Reset
        botAccounts.forEach(acc => {
            acc.stats.status = 'Idle';
            acc.stats.actions = 0;
        });
        displayBanner();
    }
}

main().catch(err => console.error(err));
