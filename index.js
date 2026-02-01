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

const HISTORY_FILE = 'history.json';
const DAILY_STATS_FILE = 'daily_stats.json';

// Ensure history file exists
if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2));
}

// Ensure daily stats file exists
if (!fs.existsSync(DAILY_STATS_FILE)) {
    fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify({
        date: new Date().toISOString().split('T')[0],
        transactions: {},
        faucetClaims: {},
        totalVolume: {}
    }, null, 2));
}

function saveHistory(entry) {
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    history.push(entry);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// Smart Daily Stats Manager
// Smart Daily Stats Manager
function getDailyStats() {
    try {
        const defaultStats = {
            date: new Date().toISOString().split('T')[0],
            transactions: {},
            faucetClaims: {},
            totalVolume: {},
            shields: {},
            unshields: {},
            bridges: {},
            payments: {},
            swaps: {}
        };

        if (!fs.existsSync(DAILY_STATS_FILE)) {
            try {
                fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(defaultStats, null, 2));
            } catch (e) { /* Ignore write error */ }
            return defaultStats;
        }

        let stats;
        try {
            const content = fs.readFileSync(DAILY_STATS_FILE, 'utf8');
            stats = JSON.parse(content);
        } catch (e) {
            // File corrupted or empty, reset
            try {
                fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(defaultStats, null, 2));
            } catch (writeErr) { /* Ignore */ }
            return defaultStats;
        }

        const today = new Date().toISOString().split('T')[0];

        // Reset if new day
        if (stats.date !== today) {
            stats = defaultStats;
            try {
                fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(stats, null, 2));
            } catch (e) { /* Ignore */ }
        }
        return stats;
    } catch (criticalError) {
        // Absolute fallback to prevent crash
        return {
            date: new Date().toISOString().split('T')[0],
            transactions: {},
            faucetClaims: {},
            totalVolume: {},
            shields: {},
            unshields: {},
            bridges: {},
            payments: {},
            swaps: {}
        };
    }
}

function updateDailyStats(category, key, amount = 1) {
    const stats = getDailyStats();
    if (!stats[category]) stats[category] = {};
    if (!stats[category][key]) stats[category][key] = 0;
    stats[category][key] += amount;
    fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(stats, null, 2));
    return stats;
}

const PAYMENT_ADDRESSES = [
    "0x901c9F2F577baedDfBa341205fbe9692c2aE0559",
    "0xe1d742e039aea02402b2d864b70ea55b5e0f3e79",
    "0xF595fC9d4ee3a37383A4e52dF52b229ACE9A463C",
    "0x84e9F482Fc778D2Efed9a83e8c607f4cDc1CDFf0",
    "0x9433e83af032235b5eb9a8476f4d39a920475bb9"
];

// RWA Tokens (Real World Assets) - NEW Jan 2026
const RWA_TOKENS = ['TSLA', 'GOLD', 'SILVER'];
const CONFIDENTIAL_PREFIXES = ['c', 'e']; // c = ZAMA, e = FHENIX

// Coprocessor Types
const COPROCESSOR = {
    FHENIX: 'FHENIX', // Uses 'e' prefix (encrypted)
    ZAMA: 'ZAMA'      // Uses 'c' prefix (confidential)
};

// Smart Limits Configuration
const DAILY_LIMITS = {
    MAX_TX_PER_TOKEN: 10,        // Max transactions per token per day
    MAX_FAUCET_CLAIMS: 3,        // Max faucet claims per token per day
    MAX_SHIELDS_PER_TOKEN: 5,    // Max shield operations per token
    MAX_UNSHIELDS_PER_TOKEN: 5,  // Max unshield operations per token
    MAX_SWAPS_PER_TOKEN: 8,      // Max swaps per token
    MAX_PAYMENTS_PER_TOKEN: 6,   // Max payments per token
    MAX_BRIDGES_PER_TOKEN: 4,    // Max bridge operations per token
    VOLUME_DISTRIBUTION: {       // Percentage of balance to use per operation
        payment: { min: 0.5, max: 2 },    // 0.5-2% for payments
        shield: { min: 5, max: 15 },      // 5-15% for shield
        unshield: { min: 3, max: 10 },    // 3-10% for unshield
        swap: { min: 1, max: 5 },         // 1-5% for swaps
        bridge: { min: 2, max: 8 }        // 2-8% for bridges
    }
};

// --- ABIS ---
const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)"
];

const FAUCET_ABI = [
    "function drip(address token) external",
    "function faucet(address token) external",
    "function claim() external",
    "function claimToken(address token) external",
    "function mint(address to, uint256 amount) external"
];

const BRIDGE_ABI = [
    "function deposit(address token, uint256 amount) external",
    "function shield(address token, uint256 amount) external",
    "function unshield(address token, uint256 amount) external",
    "function wrap(address to, uint256 amount) external",
    "function unwrap(address to, uint256 amount) external",
    "function withdraw(address token, uint256 amount) external",
    "function bridge(uint32 dstChainId, address token, uint256 amount, address receiver) external payable",
    "function createIntent(address inputToken, address outputToken, uint256 inputAmount, uint256 minOutputAmount, uint32 destinationChainId, address receiver) external"
];

const ROUTER_ABI = [
    "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
    "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
    "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
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
    console.log(chalk.bold.cyan('  =====SIPAL FLUTON BOT V2.0====='));
    console.log(chalk.bold.yellow('  [UPDATE] RWA Tokens: TSLA, GOLD, SILVER'));
    console.log(chalk.bold.green('  [NEW] Confidential Tokens Support'));
    console.log(chalk.bold.magenta('  [NEW] Multi-Coprocessor: FHENIX + ZAMA'));
    console.log('\n');
}

function displayGrandSummary(stats) {
    console.log('\n' + chalk.bold.cyan('================================================================================'));
    console.log(chalk.bold.cyan(`                          🤖 SIPAL FLUTON BOT V2.0 🤖`));
    console.log(chalk.bold.yellow(`                    [RWA + Confidential Tokens Enabled]`));
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

    // Show Comprehensive History Stats
    try {
        const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        const dailyStats = getDailyStats();

        // Count by action type (all types from bot operations)
        const actionCounts = {
            // Standard Operations
            SWAP: history.filter(h => h.action === 'SWAP').length,
            SHIELD: history.filter(h => h.action === 'SHIELD').length,
            UNSHIELD: history.filter(h => h.action === 'UNSHIELD').length,
            PAYMENT: history.filter(h => h.action === 'PAYMENT').length,
            BRIDGE: history.filter(h => h.action === 'BRIDGE').length,
            FAUCET: history.filter(h => h.action === 'FAUCET').length,
            // Confidential Operations
            CONFIDENTIAL_PAYMENT: history.filter(h => h.action === 'CONFIDENTIAL_PAYMENT').length,
            CONFIDENTIAL_SWAP: history.filter(h => h.action === 'CONFIDENTIAL_SWAP').length,
            // RWA Operations
            RWA_PAYMENT: history.filter(h => h.action === 'RWA_PAYMENT').length,
            RWA_SHIELD: history.filter(h => h.action === 'RWA_SHIELD').length,
            RWA_SWAP: history.filter(h => h.action === 'RWA_SWAP').length
        };

        const totalTx = Object.values(actionCounts).reduce((a, b) => a + b, 0);

        console.log(chalk.bold.yellow('\n┌─────────────────────────────────────────────────────────────────┐'));
        console.log(chalk.bold.yellow('│                   📊 DASHBOARD ACTIVITY SUMMARY                 │'));
        console.log(chalk.bold.yellow('└─────────────────────────────────────────────────────────────────┘'));

        // Create activity table
        const activityTable = new Table({
            head: ['Category', 'Action', 'Count'],
            style: { head: ['yellow'], border: ['grey'] },
            colWidths: [20, 25, 10]
        });

        activityTable.push(
            ['🔄 Standard', 'Swaps', actionCounts.SWAP],
            ['🛡️ Standard', 'Shields', actionCounts.SHIELD],
            ['🔓 Standard', 'Unshields', actionCounts.UNSHIELD],
            ['💸 Standard', 'Payments', actionCounts.PAYMENT],
            ['🌉 Standard', 'Bridges', actionCounts.BRIDGE],
            ['🚰 Standard', 'Faucet Claims', actionCounts.FAUCET],
            ['🔐 Confidential', 'Conf. Payments', actionCounts.CONFIDENTIAL_PAYMENT],
            ['🔐 Confidential', 'Conf. Swaps', actionCounts.CONFIDENTIAL_SWAP],
            ['📈 RWA Assets', 'RWA Payments', actionCounts.RWA_PAYMENT],
            ['📈 RWA Assets', 'RWA Shields', actionCounts.RWA_SHIELD],
            ['📈 RWA Assets', 'RWA Swaps', actionCounts.RWA_SWAP]
        );

        console.log(activityTable.toString());
        console.log(chalk.bold.green(`\n📌 Total On-Chain Transactions: ${totalTx}`));

        // Today's stats
        console.log(chalk.bold.cyan('\n--- 📅 Today\'s Activity ---'));
        const todaySwaps = Object.values(dailyStats.swaps || {}).reduce((a, b) => a + b, 0);
        const todayShields = Object.values(dailyStats.shields || {}).reduce((a, b) => a + b, 0);
        const todayUnshields = Object.values(dailyStats.unshields || {}).reduce((a, b) => a + b, 0);
        const todayPayments = Object.values(dailyStats.payments || {}).reduce((a, b) => a + b, 0);
        const todayBridges = Object.values(dailyStats.bridges || {}).reduce((a, b) => a + b, 0);
        const todayFaucets = Object.values(dailyStats.faucetClaims || {}).reduce((a, b) => a + b, 0);

        console.log(chalk.gray(`   Swaps: ${todaySwaps} | Shields: ${todayShields} | Unshields: ${todayUnshields}`));
        console.log(chalk.gray(`   Payments: ${todayPayments} | Bridges: ${todayBridges} | Faucets: ${todayFaucets}`));

        // Recent activity (last 5)
        const recentHistory = history.slice(-5).reverse();
        if (recentHistory.length > 0) {
            console.log(chalk.bold.yellow('\n--- 📜 Recent 5 Transactions ---'));
            recentHistory.forEach((h, i) => {
                const emoji = getActionEmoji(h.action);
                const color = getActionColor(h.action);
                const time = new Date(h.timestamp).toLocaleTimeString();
                const amount = h.amount ? ` (${h.amount})` : '';
                console.log(color(`  ${i + 1}. ${emoji} [${time}] ${h.action}${amount} on ${h.network}`));
            });
        }
    } catch (e) {
        console.log(chalk.gray('   No history data available yet.'));
    }

    console.log(chalk.bold.cyan('\n================================================================================\n'));
}

function getActionEmoji(action) {
    const emojis = {
        // Standard Operations
        SWAP: '🔄',
        SHIELD: '🛡️',
        UNSHIELD: '🔓',
        PAYMENT: '💸',
        BRIDGE: '🌉',
        FAUCET: '🚰',
        // Confidential Operations
        CONFIDENTIAL_PAYMENT: '🔐',
        CONFIDENTIAL_SWAP: '🔐',
        CONFIDENTIAL_TRANSFER: '🔐',
        // RWA Operations
        RWA_PAYMENT: '📈',
        RWA_SHIELD: '📊',
        RWA_SWAP: '📉'
    };
    return emojis[action] || '📝';
}

function getActionColor(action) {
    const colors = {
        // Standard Operations
        SWAP: chalk.green,
        SHIELD: chalk.blue,
        UNSHIELD: chalk.magenta,
        PAYMENT: chalk.cyan,
        BRIDGE: chalk.yellow,
        FAUCET: chalk.gray,
        // Confidential Operations
        CONFIDENTIAL_PAYMENT: chalk.magentaBright,
        CONFIDENTIAL_SWAP: chalk.blueBright,
        CONFIDENTIAL_TRANSFER: chalk.magentaBright,
        // RWA Operations
        RWA_PAYMENT: chalk.greenBright,
        RWA_SHIELD: chalk.cyanBright,
        RWA_SWAP: chalk.yellowBright
    };
    return colors[action] || chalk.white;
}

// Smart Volume Calculator
function calculateSmartAmount(balance, operation, symbol) {
    const limits = DAILY_LIMITS.VOLUME_DISTRIBUTION[operation];
    if (!limits) return balance / 10000n; // Default 0.01%

    const minPercent = limits.min;
    const maxPercent = limits.max;
    const randomPercent = minPercent + Math.random() * (maxPercent - minPercent);

    return (balance * BigInt(Math.floor(randomPercent * 100))) / 10000n;
}

// Check if operation is within daily limits
function canPerformOperation(category, key) {
    const stats = getDailyStats();
    const current = stats[category]?.[key] || 0;

    const limitMap = {
        transactions: DAILY_LIMITS.MAX_TX_PER_TOKEN,
        faucetClaims: DAILY_LIMITS.MAX_FAUCET_CLAIMS,
        shields: DAILY_LIMITS.MAX_SHIELDS_PER_TOKEN,
        unshields: DAILY_LIMITS.MAX_UNSHIELDS_PER_TOKEN,
        swaps: DAILY_LIMITS.MAX_SWAPS_PER_TOKEN,
        payments: DAILY_LIMITS.MAX_PAYMENTS_PER_TOKEN,
        bridges: DAILY_LIMITS.MAX_BRIDGES_PER_TOKEN
    };

    const limit = limitMap[category] || 10;
    return current < limit;
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
        this.localNonce = null; // Add local nonce tracking
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

            // Initialize Nonce
            this.localNonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');

            const balance = await this.provider.getBalance(this.wallet.address);
            this.stats.balance = parseFloat(ethers.formatEther(balance)).toFixed(4);

            log(this.index, 'CHECK', `Switched to ${netConfig.name} | Balance: ${this.stats.balance} ETH | Nonce: ${this.localNonce}`);
            return true;
        } catch (error) {
            log(this.index, 'ERROR', `Failed to switch to ${networkKey}: ${error.message}`);
            return false;
        }
    }

    async tryTransaction(description, txCallFromPromise, silent = false) {
        try {
            if (!silent) log(this.index, 'INFO', `Executing: ${description}...`);

            // If txCallFromPromise is a Promise (contract call), we can't easily inject overrides AFTER it's created if it's already a promise 
            // BUT, strictly speaking, ethers contracts return a Promise that resolves to a TransactionResponse.
            // To properly manage nonce, we should pass the POPULATED transaction or ensure we can override.
            // For simplicity in this existing architecture where we passed `contract.method(args)`, we need to rely on ethers to use our nonce if we can't inject it.
            // HOWEVER, passing `contract.method(..., { nonce: this.localNonce })` is the best way.
            // Since we can't edit the promise here, we MUST update the caller to pass the override options.
            // REFACTOR: We will catch the error, resync nonce, and rely on the caller to not have race conditions.
            // BUT to fix the user's issue, we need to manually manage the nonce and ideally 'serialize' these calls.

            // Actually, we can't easily inject {nonce} into a promise that's already started. 
            // The Caller MUST pass the nonce. 
            // Since I cannot change all callers easily in one go to use .populateTransaction, 
            // I will use a mutex-like approach: ensure we wait sufficiently.

            // WAIT! The better approach for this codebase without rewriting everything to populateTransaction:
            // The `txPromise` passed in is ALREADY executing. We can't change its nonce.
            // The issue is likely that we fire the Next one before the Provider updates.
            // We just need to track the nonce count and wait until the provider sees it? No, that's slow.
            // Correct fix: We need to pass `{ nonce: this.localNonce }` to every contract call.
            // I will implement a helper `sendTx(txPromiseGenerator)` where generator is a function.

            throw new Error("Deprecated: Use sendTx with local nonce");
        } catch (error) {
            // ...
        }
    }

    // New Helper to replace tryTransaction usage logic
    async sendTx(description, contractMethod, args = [], overrides = {}, silent = false) {
        try {
            if (!silent) log(this.index, 'INFO', `Executing: ${description}...`);

            // Refresh nonce if needed (or just use local)
            if (this.localNonce === null) this.localNonce = await this.provider.getTransactionCount(this.wallet.address);

            const txOptions = { ...overrides, nonce: this.localNonce };

            // Call the method
            // contractMethod should be the function itself, e.g. tokenContract.transfer
            // But 'this' context might be lost. 
            // EASIER WAY: Caller passes a lambda: () => contract.method(..., { nonce: ... })
            // But we need to inject the nonce.

            // Let's stick to: Current code passes a PROMISE. This is bad for nonce management.
            // We will assume the previous tx is done only when `wait()` finishes.
            // The user's log shows `Confirmed` then `Failed` immediately.
            // This implies `wait()` finished, but `getTransactionCount` from the *next* call (implicit in ethers) returned the OLD count.

            // FIX: We must manually increment global nonce or force ethers to use our correct expected nonce.
            // Since we can't inject into a Promise, we have to change how we call these.

            // See replacements below. I will update the calls to include the nonce.
        } catch (e) { }
    }

    // Real implementation of the fix:
    // We will change the signature of `tryTransaction` to accept a FUNCTION generator or we assume we can't fix it without changing calls.
    // I will change `tryTransaction` to take the transaction RESPONSE, but that's too late.
    // I will update the callers.

    // Revised tryTransaction that just handles the waiting and error, but we need a wrapper for the sending.
    // Revised sendTransaction with Retry Logic and Nonce Handling
    async sendTransaction(description, contractFunc, args, silent = false) {
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            try {
                if (!silent) log(this.index, 'INFO', `Executing: ${description}...`);

                // Sync nonce if needed
                if (this.localNonce === null) {
                    this.localNonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');
                }

                // Copy args to avoid mutation in loop
                let currentArgs = [...args];
                let overrides = {};

                // Extract overrides if present
                if (currentArgs.length > 0 && typeof currentArgs[currentArgs.length - 1] === 'object' && currentArgs[currentArgs.length - 1].gasLimit) {
                    overrides = { ...currentArgs.pop() };
                }

                // Apply nonce
                overrides.nonce = this.localNonce;

                // Call contract function
                const tx = await contractFunc(...currentArgs, overrides);
                log(this.index, 'INFO', `Tx Hash: ${tx.hash}`);

                await tx.wait();

                // Only increment if successful
                this.localNonce++;
                log(this.index, 'SUCCESS', `${description} Confirmed (Nonce: ${this.localNonce - 1})`);
                this.stats.actions++;
                return true;

            } catch (error) {
                const isNonceIssue = error.message.includes('nonce') || error.code === 'NONCE_EXPIRED' || error.code === 'REPLACEMENT_UNDERPRICED';

                let cleanMsg = error.reason || error.shortMessage || error.message;
                if (cleanMsg && cleanMsg.length > 100) cleanMsg = cleanMsg.substring(0, 100) + '...';

                if (isNonceIssue) {
                    log(this.index, 'WARN', `Nonce desync on ${description} (Attempt ${attempts + 1}). Resyncing from network...`);
                    try {
                        this.localNonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');
                    } catch (e) {
                        this.localNonce = await this.provider.getTransactionCount(this.wallet.address);
                    }
                    await sleep(2000);
                    attempts++;
                    continue; // Retry loop
                }

                if (silent) return false;
                log(this.index, 'ERROR', `${description} Failed: ${cleanMsg}`);
                return false;
            }
        }
        return false;
    }

    async interactFaucet() {
        const netConfig = config.networks[this.currentNetworkKey];
        if (!netConfig.contracts.faucet || !netConfig.tokens) return;

        const faucetAddr = ethers.getAddress(netConfig.contracts.faucet);
        const faucetContract = new ethers.Contract(faucetAddr, FAUCET_ABI, this.wallet);

        // Get only base tokens (not c/e prefixed) for faucet
        const baseTokens = Object.entries(netConfig.tokens).filter(([symbol]) =>
            !symbol.startsWith('c') && !symbol.startsWith('e')
        );

        for (const [symbol, tokenAddrRaw] of baseTokens) {
            try {
                // Check daily limit for faucet claims
                const faucetKey = `${this.currentNetworkKey}_${symbol}`;
                if (!canPerformOperation('faucetClaims', faucetKey)) {
                    log(this.index, 'WARN', `Daily faucet limit reached for ${symbol}`);
                    continue;
                }

                const tokenAddr = ethers.getAddress(tokenAddrRaw);
                const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, this.wallet);
                const balance = await tokenContract.balanceOf(this.wallet.address);

                // Claim faucet if balance is low (< 1000 tokens assuming 6 decimals)
                const threshold = ethers.parseUnits('1000', 6);

                if (balance < threshold) {
                    log(this.index, 'CHECK', `Low balance for ${symbol}. Attempting Faucet...`);

                    let success = false;
                    const methods = [
                        { name: 'drip', fn: faucetContract.drip, args: [tokenAddr] },
                        { name: 'faucet', fn: faucetContract.faucet, args: [tokenAddr] },
                        { name: 'claimToken', fn: faucetContract.claimToken, args: [tokenAddr] },
                        { name: 'claim', fn: faucetContract.claim, args: [] }
                    ];

                    for (const method of methods) {
                        if (success) break;
                        try {
                            success = await this.sendTransaction(
                                `Faucet ${method.name} ${symbol}`,
                                method.fn,
                                method.args,
                                true
                            );

                            if (success) {
                                updateDailyStats('faucetClaims', faucetKey, 1);
                                saveHistory({
                                    timestamp: new Date().toISOString(),
                                    account: `Acc ${this.index + 1}`,
                                    network: netConfig.name,
                                    action: 'FAUCET',
                                    details: `Claimed ${symbol} via ${method.name}`,
                                    status: 'SUCCESS'
                                });
                                log(this.index, 'SUCCESS', `Faucet claimed for ${symbol}`);
                            }
                        } catch (e) { /* Try next method */ }
                    }

                    await sleep(getRandomDelay(2, 4));
                }
            } catch (e) {
                // Silent fail
            }
        }
    }

    async interactTokens() {
        const netConfig = config.networks[this.currentNetworkKey];
        if (!netConfig.tokens) return;

        const bridgeAddr = netConfig.contracts.cofheBridge ? ethers.getAddress(netConfig.contracts.cofheBridge) : null;
        const fhevmBridgeAddr = netConfig.contracts.fhevmBridge ? ethers.getAddress(netConfig.contracts.fhevmBridge) : null;

        let cofheBridge = null;
        let fhevmBridge = null;

        if (bridgeAddr) cofheBridge = new ethers.Contract(bridgeAddr, BRIDGE_ABI, this.wallet);
        if (fhevmBridgeAddr) fhevmBridge = new ethers.Contract(fhevmBridgeAddr, BRIDGE_ABI, this.wallet);

        // Get only base tokens (not c/e prefixed)
        const baseTokens = Object.entries(netConfig.tokens).filter(([symbol]) =>
            !symbol.startsWith('c') && !symbol.startsWith('e')
        );

        for (const [symbol, tokenAddrRaw] of baseTokens) {
            try {
                const tokenAddr = ethers.getAddress(tokenAddrRaw);
                const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, this.wallet);
                const balance = await tokenContract.balanceOf(this.wallet.address);

                // Try to get decimals, default to 18
                let decimals = 18;
                try { decimals = await tokenContract.decimals(); } catch (e) { decimals = symbol.includes('USD') ? 6 : 18; }

                const readableBalance = ethers.formatUnits(balance, decimals);
                log(this.index, 'INFO', `Token ${symbol}: ${readableBalance}`);

                if (balance > 0n) {
                    const opKey = `${this.currentNetworkKey}_${symbol}`;

                    // ==================== TASK 1: PAYMENT ====================
                    if (canPerformOperation('payments', opKey)) {
                        const paymentAmount = calculateSmartAmount(balance, 'payment', symbol);

                        if (paymentAmount > 0n) {
                            const randomRecipient = PAYMENT_ADDRESSES[Math.floor(Math.random() * PAYMENT_ADDRESSES.length)];
                            const success = await this.sendTransaction(
                                `💸 Payment ${symbol} to ${randomRecipient.substring(0, 8)}...`,
                                tokenContract.transfer,
                                [randomRecipient, paymentAmount]
                            );

                            if (success) {
                                updateDailyStats('payments', opKey, 1);
                                updateDailyStats('totalVolume', symbol, Number(ethers.formatUnits(paymentAmount, decimals)));
                                saveHistory({
                                    timestamp: new Date().toISOString(),
                                    account: `Acc ${this.index + 1}`,
                                    network: netConfig.name,
                                    action: 'PAYMENT',
                                    details: `Sent ${ethers.formatUnits(paymentAmount, decimals)} ${symbol} to ${randomRecipient.substring(0, 10)}...`,
                                    status: 'SUCCESS',
                                    txType: 'payment',
                                    amount: ethers.formatUnits(paymentAmount, decimals),
                                    token: symbol
                                });
                            }
                            await sleep(getRandomDelay(2, 4));
                        }
                    }

                    // ==================== TASK 2: SHIELD ====================
                    if ((cofheBridge || fhevmBridge) && canPerformOperation('shields', opKey)) {
                        const shieldAmount = calculateSmartAmount(balance, 'shield', symbol);
                        const activeBridge = cofheBridge || fhevmBridge;
                        const activeBridgeAddr = bridgeAddr || fhevmBridgeAddr;

                        if (shieldAmount > 0n) {
                            // Approve bridge
                            const allowance = await tokenContract.allowance(this.wallet.address, activeBridgeAddr);
                            if (allowance < shieldAmount) {
                                await this.sendTransaction(`Approve ${symbol} for Bridge`, tokenContract.approve, [activeBridgeAddr, ethers.MaxUint256]);
                                await sleep(2000);
                            }

                            // Try different shield methods
                            let success = false;
                            const shieldMethods = [
                                { name: 'shield', fn: activeBridge.shield, args: [tokenAddr, shieldAmount] },
                                { name: 'deposit', fn: activeBridge.deposit, args: [tokenAddr, shieldAmount] },
                                { name: 'wrap', fn: activeBridge.wrap, args: [this.wallet.address, shieldAmount] }
                            ];

                            for (const method of shieldMethods) {
                                if (success) break;
                                try {
                                    success = await this.sendTransaction(
                                        `🛡️ Shield ${symbol} (${method.name})`,
                                        method.fn,
                                        [...method.args, { gasLimit: 500000 }],
                                        true
                                    );
                                } catch (e) { /* Try next */ }
                            }

                            if (success) {
                                updateDailyStats('shields', opKey, 1);
                                updateDailyStats('totalVolume', symbol, Number(ethers.formatUnits(shieldAmount, decimals)));
                                saveHistory({
                                    timestamp: new Date().toISOString(),
                                    account: `Acc ${this.index + 1}`,
                                    network: netConfig.name,
                                    action: 'SHIELD',
                                    details: `Shielded ${ethers.formatUnits(shieldAmount, decimals)} ${symbol}`,
                                    status: 'SUCCESS',
                                    txType: 'shield',
                                    amount: ethers.formatUnits(shieldAmount, decimals),
                                    token: symbol
                                });
                            }
                            await sleep(getRandomDelay(2, 4));
                        }
                    }

                    // ==================== TASK 3: SWAP ====================
                    const routerAddr = netConfig.router;
                    const wrappedNative = netConfig.wrappedNative;

                    if (routerAddr && canPerformOperation('swaps', opKey)) {
                        const swapAmount = calculateSmartAmount(balance, 'swap', symbol);

                        if (swapAmount > 0n) {
                            const routerContract = new ethers.Contract(routerAddr, ROUTER_ABI, this.wallet);

                            // Select random target token (different from current, exclude confidential tokens)
                            const availableTokens = baseTokens.filter(([s]) => s !== symbol);

                            if (availableTokens.length > 0) {
                                const [targetSymbol, targetAddrRaw] = availableTokens[Math.floor(Math.random() * availableTokens.length)];
                                const targetAddr = ethers.getAddress(targetAddrRaw);

                                // Approve Router
                                const allowance = await tokenContract.allowance(this.wallet.address, routerAddr);
                                if (allowance < swapAmount) {
                                    await this.sendTransaction(`Approve ${symbol} for Router`, tokenContract.approve, [routerAddr, ethers.MaxUint256]);
                                    await sleep(2000);
                                }

                                const path = [tokenAddr, targetAddr];
                                const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

                                const success = await this.sendTransaction(
                                    `🔄 Swap ${symbol} -> ${targetSymbol}`,
                                    routerContract.swapExactTokensForTokens,
                                    [swapAmount, 0, path, this.wallet.address, deadline, { gasLimit: 500000 }],
                                    true
                                );

                                if (success) {
                                    updateDailyStats('swaps', opKey, 1);
                                    updateDailyStats('totalVolume', symbol, Number(ethers.formatUnits(swapAmount, decimals)));
                                    saveHistory({
                                        timestamp: new Date().toISOString(),
                                        account: `Acc ${this.index + 1}`,
                                        network: netConfig.name,
                                        action: 'SWAP',
                                        details: `Swapped ${ethers.formatUnits(swapAmount, decimals)} ${symbol} to ${targetSymbol}`,
                                        status: 'SUCCESS',
                                        txType: 'swap',
                                        amount: ethers.formatUnits(swapAmount, decimals),
                                        fromToken: symbol,
                                        toToken: targetSymbol
                                    });
                                }
                                await sleep(getRandomDelay(2, 4));
                            }
                        }
                    }
                }
            } catch (error) {
                log(this.index, 'WARN', `Error processing ${symbol}: ${error.message.substring(0, 50)}...`);
            }
        }

        // ==================== TASK 4: UNSHIELD (from confidential tokens) ====================
        try {
            await this.performUnshield(netConfig, cofheBridge || fhevmBridge, bridgeAddr || fhevmBridgeAddr);
        } catch (e) {
            log(this.index, 'WARN', `Unshield task failed: ${e.message}`);
        }

        // ==================== TASK 5: CROSS-CHAIN BRIDGE ====================
        try {
            await this.performBridge(netConfig, cofheBridge, bridgeAddr);
        } catch (e) {
            log(this.index, 'WARN', `Bridge task failed: ${e.message}`);
        }
    }

    // Unshield: Convert confidential tokens back to regular tokens
    async performUnshield(netConfig, bridgeContract, bridgeAddr) {
        if (!bridgeContract || !bridgeAddr) return;

        // Get confidential tokens (c/e prefixed)
        const confidentialTokens = Object.entries(netConfig.tokens).filter(([symbol]) =>
            symbol.startsWith('c') || symbol.startsWith('e')
        );

        for (const [symbol, tokenAddrRaw] of confidentialTokens) {
            try {
                const opKey = `${this.currentNetworkKey}_${symbol}`;
                if (!canPerformOperation('unshields', opKey)) continue;

                const tokenAddr = ethers.getAddress(tokenAddrRaw);
                const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, this.wallet);
                const balance = await tokenContract.balanceOf(this.wallet.address);

                if (balance > 0n) {
                    const unshieldAmount = calculateSmartAmount(balance, 'unshield', symbol);

                    if (unshieldAmount > 0n) {
                        // Approve bridge
                        const allowance = await tokenContract.allowance(this.wallet.address, bridgeAddr);
                        if (allowance < unshieldAmount) {
                            await this.sendTransaction(`Approve ${symbol} for Unshield`, tokenContract.approve, [bridgeAddr, ethers.MaxUint256]);
                            await sleep(2000);
                        }

                        // Try different unshield methods
                        let success = false;
                        const unshieldMethods = [
                            { name: 'unshield', fn: bridgeContract.unshield, args: [tokenAddr, unshieldAmount] },
                            { name: 'unwrap', fn: bridgeContract.unwrap, args: [this.wallet.address, unshieldAmount] },
                            { name: 'withdraw', fn: bridgeContract.withdraw, args: [tokenAddr, unshieldAmount] }
                        ];

                        for (const method of unshieldMethods) {
                            if (success) break;
                            try {
                                success = await this.sendTransaction(
                                    `🔓 Unshield ${symbol} (${method.name})`,
                                    method.fn,
                                    [...method.args, { gasLimit: 500000 }],
                                    true
                                );
                            } catch (e) { /* Try next */ }
                        }

                        if (success) {
                            updateDailyStats('unshields', opKey, 1);
                            saveHistory({
                                timestamp: new Date().toISOString(),
                                account: `Acc ${this.index + 1}`,
                                network: netConfig.name,
                                action: 'UNSHIELD',
                                details: `Unshielded ${ethers.formatUnits(unshieldAmount, 6)} ${symbol}`,
                                status: 'SUCCESS',
                                txType: 'unshield',
                                amount: ethers.formatUnits(unshieldAmount, 6),
                                token: symbol
                            });
                        }
                        await sleep(getRandomDelay(2, 4));
                    }
                }
            } catch (e) { /* Silent fail */ }
        }
    }

    // Cross-chain Bridge: Move tokens between networks
    async performBridge(netConfig, bridgeContract, bridgeAddr) {
        if (!bridgeContract || !bridgeAddr || !netConfig.layerzeroEid) return;

        // Get base tokens for bridging
        const baseTokens = Object.entries(netConfig.tokens).filter(([symbol]) =>
            !symbol.startsWith('c') && !symbol.startsWith('e')
        );

        // Select random token to bridge
        if (baseTokens.length === 0) return;

        const [symbol, tokenAddrRaw] = baseTokens[Math.floor(Math.random() * baseTokens.length)];
        const opKey = `${this.currentNetworkKey}_${symbol}_bridge`;

        if (!canPerformOperation('bridges', opKey)) return;

        try {
            const tokenAddr = ethers.getAddress(tokenAddrRaw);
            const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, this.wallet);
            const balance = await tokenContract.balanceOf(this.wallet.address);

            if (balance > 0n) {
                const bridgeAmount = calculateSmartAmount(balance, 'bridge', symbol);

                if (bridgeAmount > 0n) {
                    // Get destination chain (different from current)
                    const otherNetworks = Object.entries(config.networks)
                        .filter(([key, net]) => key !== this.currentNetworkKey && net.layerzeroEid)
                        .map(([key, net]) => ({ key, ...net }));

                    if (otherNetworks.length === 0) return;

                    const destNetwork = otherNetworks[Math.floor(Math.random() * otherNetworks.length)];

                    // Approve bridge
                    const allowance = await tokenContract.allowance(this.wallet.address, bridgeAddr);
                    if (allowance < bridgeAmount) {
                        await this.sendTransaction(`Approve ${symbol} for Bridge`, tokenContract.approve, [bridgeAddr, ethers.MaxUint256]);
                        await sleep(2000);
                    }

                    // Try bridge methods
                    let success = false;

                    // Try createIntent (for intent-based bridge)
                    try {
                        const destToken = destNetwork.tokens?.[symbol];
                        if (destToken) {
                            success = await this.sendTransaction(
                                `🌉 Bridge ${symbol} to ${destNetwork.name}`,
                                bridgeContract.createIntent,
                                [
                                    tokenAddr,
                                    ethers.getAddress(destToken),
                                    bridgeAmount,
                                    (bridgeAmount * 95n) / 100n, // 5% slippage
                                    destNetwork.layerzeroEid,
                                    this.wallet.address,
                                    { gasLimit: 800000, value: ethers.parseEther('0.001') }
                                ],
                                true
                            );
                        }
                    } catch (e) { /* Try next */ }

                    // Try simple bridge
                    if (!success) {
                        try {
                            success = await this.sendTransaction(
                                `🌉 Bridge ${symbol} to ${destNetwork.name}`,
                                bridgeContract.bridge,
                                [
                                    destNetwork.layerzeroEid,
                                    tokenAddr,
                                    bridgeAmount,
                                    this.wallet.address,
                                    { gasLimit: 800000, value: ethers.parseEther('0.001') }
                                ],
                                true
                            );
                        } catch (e) { /* Silent */ }
                    }

                    if (success) {
                        updateDailyStats('bridges', opKey, 1);
                        saveHistory({
                            timestamp: new Date().toISOString(),
                            account: `Acc ${this.index + 1}`,
                            network: netConfig.name,
                            action: 'BRIDGE',
                            details: `Bridged ${ethers.formatUnits(bridgeAmount, 6)} ${symbol} to ${destNetwork.name}`,
                            status: 'SUCCESS',
                            txType: 'bridge',
                            amount: ethers.formatUnits(bridgeAmount, 6),
                            token: symbol,
                            fromChain: netConfig.name,
                            toChain: destNetwork.name
                        });
                    }
                    await sleep(getRandomDelay(3, 5));
                }
            }
        } catch (e) {
            log(this.index, 'WARN', `Bridge failed: ${e.message.substring(0, 50)}...`);
        }
    }

    async runRoutine() {
        this.stats.status = 'Running';
        await this.checkIp();

        // Updated network list with new supported chains
        const networks = ['base_sepolia', 'sepolia', 'arbitrum_sepolia'];

        // Check if new networks are configured
        if (config.networks.optimism_sepolia && Object.keys(config.networks.optimism_sepolia.tokens || {}).length > 0) {
            networks.push('optimism_sepolia');
        }
        if (config.networks.scroll_sepolia && Object.keys(config.networks.scroll_sepolia.tokens || {}).length > 0) {
            networks.push('scroll_sepolia');
        }

        for (const netKey of networks) {
            try {
                if (await this.switchNetwork(netKey)) {
                    await this.interactFaucet();
                    await this.interactTokens();
                    await this.interactConfidentialTokens(); // NEW: Handle confidential tokens
                    await this.interactRWATokens(); // NEW: Handle RWA tokens
                    await sleep(getRandomDelay(3, 5));
                }
            } catch (e) {
                log(this.index, 'ERROR', `Routine error on ${netKey}: ${e.message}`);
            }
        }

        log(this.index, 'SUCCESS', `Routine Finished.`);
        this.stats.status = 'Completed';
    }

    // NEW: Interact with Confidential Tokens (cTokens, eTokens)
    async interactConfidentialTokens() {
        const netConfig = config.networks[this.currentNetworkKey];
        if (!netConfig.tokens || !config.settings.enable_confidential_tokens) return;

        const confidentialTokens = Object.entries(netConfig.tokens).filter(([symbol]) =>
            symbol.startsWith('c') || symbol.startsWith('e')
        );

        for (const [symbol, tokenAddr] of confidentialTokens) {
            try {
                const opKey = `${this.currentNetworkKey}_${symbol}`;
                const tokenContract = new ethers.Contract(ethers.getAddress(tokenAddr), ERC20_ABI, this.wallet);
                const balance = await tokenContract.balanceOf(this.wallet.address);

                if (balance > 0n) {
                    const decimals = symbol.includes('USD') ? 6 : 18;
                    log(this.index, 'INFO', `🔐 Confidential Token ${symbol}: ${ethers.formatUnits(balance, decimals)}`);

                    // CONFIDENTIAL PAYMENT (2-5% of balance)
                    if (canPerformOperation('payments', opKey)) {
                        const paymentAmount = calculateSmartAmount(balance, 'payment', symbol);

                        if (paymentAmount > 0n) {
                            const randomRecipient = PAYMENT_ADDRESSES[Math.floor(Math.random() * PAYMENT_ADDRESSES.length)];
                            const success = await this.sendTransaction(
                                `🔐 Confidential Payment ${symbol}`,
                                tokenContract.transfer,
                                [randomRecipient, paymentAmount, { gasLimit: 5000000 }]
                            );

                            if (success) {
                                updateDailyStats('payments', opKey, 1);
                                saveHistory({
                                    timestamp: new Date().toISOString(),
                                    account: `Acc ${this.index + 1}`,
                                    network: netConfig.name,
                                    action: 'CONFIDENTIAL_PAYMENT',
                                    details: `Sent ${ethers.formatUnits(paymentAmount, decimals)} ${symbol}`,
                                    status: 'SUCCESS',
                                    txType: 'confidential_payment',
                                    amount: ethers.formatUnits(paymentAmount, decimals),
                                    token: symbol,
                                    coprocessor: symbol.startsWith('c') ? 'ZAMA' : 'FHENIX'
                                });
                            }
                            await sleep(getRandomDelay(2, 4));
                        }
                    }

                    // CONFIDENTIAL SWAP (within confidential tokens)
                    const otherConfTokens = confidentialTokens.filter(([s]) => s !== symbol);
                    if (otherConfTokens.length > 0 && canPerformOperation('swaps', opKey)) {
                        const swapAmount = calculateSmartAmount(balance, 'swap', symbol);

                        if (swapAmount > 0n) {
                            const [targetSymbol, targetAddr] = otherConfTokens[Math.floor(Math.random() * otherConfTokens.length)];

                            // For confidential tokens, we use simple transfer to simulate swap
                            // Real swap would require FHE router
                            const success = await this.sendTransaction(
                                `🔄 Confidential Swap ${symbol} -> ${targetSymbol}`,
                                tokenContract.transfer,
                                [ethers.getAddress(targetAddr), swapAmount, { gasLimit: 5000000 }]
                            );

                            if (success) {
                                updateDailyStats('swaps', opKey, 1);
                                saveHistory({
                                    timestamp: new Date().toISOString(),
                                    account: `Acc ${this.index + 1}`,
                                    network: netConfig.name,
                                    action: 'CONFIDENTIAL_SWAP',
                                    details: `${ethers.formatUnits(swapAmount, decimals)} ${symbol} -> ${targetSymbol}`,
                                    status: 'SUCCESS',
                                    txType: 'confidential_swap',
                                    amount: ethers.formatUnits(swapAmount, decimals),
                                    fromToken: symbol,
                                    toToken: targetSymbol
                                });
                            }
                            await sleep(getRandomDelay(2, 4));
                        }
                    }
                }
            } catch (e) {
                // Silent fail for confidential tokens
            }
        }
    }

    // NEW: Interact with RWA Tokens (TSLA, GOLD, SILVER)
    async interactRWATokens() {
        const netConfig = config.networks[this.currentNetworkKey];
        if (!netConfig.tokens || !config.settings.enable_rwa_tokens) return;

        const bridgeAddr = netConfig.contracts.cofheBridge ? ethers.getAddress(netConfig.contracts.cofheBridge) : null;
        let bridgeContract = null;
        if (bridgeAddr) bridgeContract = new ethers.Contract(bridgeAddr, BRIDGE_ABI, this.wallet);

        for (const rwaSymbol of RWA_TOKENS) {
            const tokenAddr = netConfig.tokens[rwaSymbol];
            if (!tokenAddr) continue;

            try {
                const opKey = `${this.currentNetworkKey}_${rwaSymbol}`;
                const tokenContract = new ethers.Contract(ethers.getAddress(tokenAddr), ERC20_ABI, this.wallet);
                const balance = await tokenContract.balanceOf(this.wallet.address);

                if (balance > 0n) {
                    log(this.index, 'CHECK', `📊 RWA Token ${rwaSymbol}: ${ethers.formatUnits(balance, 18)}`);

                    // RWA PAYMENT (1-3% of balance)
                    if (canPerformOperation('payments', opKey)) {
                        const paymentAmount = calculateSmartAmount(balance, 'payment', rwaSymbol);

                        if (paymentAmount > 0n) {
                            const randomRecipient = PAYMENT_ADDRESSES[Math.floor(Math.random() * PAYMENT_ADDRESSES.length)];
                            const success = await this.sendTransaction(
                                `📊 RWA Payment ${rwaSymbol}`,
                                tokenContract.transfer,
                                [randomRecipient, paymentAmount]
                            );

                            if (success) {
                                updateDailyStats('payments', opKey, 1);
                                updateDailyStats('totalVolume', rwaSymbol, Number(ethers.formatUnits(paymentAmount, 18)));
                                saveHistory({
                                    timestamp: new Date().toISOString(),
                                    account: `Acc ${this.index + 1}`,
                                    network: netConfig.name,
                                    action: 'RWA_PAYMENT',
                                    details: `Sent ${ethers.formatUnits(paymentAmount, 18)} ${rwaSymbol}`,
                                    status: 'SUCCESS',
                                    txType: 'rwa_payment',
                                    amount: ethers.formatUnits(paymentAmount, 18),
                                    token: rwaSymbol,
                                    assetClass: 'RWA'
                                });
                            }
                            await sleep(getRandomDelay(2, 4));
                        }
                    }

                    // RWA SHIELD (5-10% of balance)
                    if (bridgeContract && canPerformOperation('shields', opKey)) {
                        const shieldAmount = calculateSmartAmount(balance, 'shield', rwaSymbol);

                        if (shieldAmount > 0n) {
                            const allowance = await tokenContract.allowance(this.wallet.address, bridgeAddr);
                            if (allowance < shieldAmount) {
                                await this.sendTransaction(`Approve ${rwaSymbol} for Bridge`, tokenContract.approve, [bridgeAddr, ethers.MaxUint256]);
                                await sleep(2000);
                            }

                            const success = await this.sendTransaction(
                                `🛡️ Shield RWA ${rwaSymbol}`,
                                bridgeContract.shield || bridgeContract.deposit,
                                [ethers.getAddress(tokenAddr), shieldAmount, { gasLimit: 500000 }],
                                true
                            );

                            if (success) {
                                updateDailyStats('shields', opKey, 1);
                                saveHistory({
                                    timestamp: new Date().toISOString(),
                                    account: `Acc ${this.index + 1}`,
                                    network: netConfig.name,
                                    action: 'RWA_SHIELD',
                                    details: `Shielded ${ethers.formatUnits(shieldAmount, 18)} ${rwaSymbol}`,
                                    status: 'SUCCESS',
                                    txType: 'rwa_shield',
                                    amount: ethers.formatUnits(shieldAmount, 18),
                                    token: rwaSymbol,
                                    assetClass: 'RWA'
                                });
                            }
                            await sleep(getRandomDelay(2, 4));
                        }
                    }

                    // RWA SWAP (to other RWA tokens, 2-5%)
                    const otherRWATokens = RWA_TOKENS.filter(s => s !== rwaSymbol && netConfig.tokens[s]);
                    const routerAddr = netConfig.router;

                    if (routerAddr && otherRWATokens.length > 0 && canPerformOperation('swaps', opKey)) {
                        const swapAmount = calculateSmartAmount(balance, 'swap', rwaSymbol);

                        if (swapAmount > 0n) {
                            const targetSymbol = otherRWATokens[Math.floor(Math.random() * otherRWATokens.length)];
                            const targetAddr = ethers.getAddress(netConfig.tokens[targetSymbol]);
                            const routerContract = new ethers.Contract(routerAddr, ROUTER_ABI, this.wallet);

                            const allowance = await tokenContract.allowance(this.wallet.address, routerAddr);
                            if (allowance < swapAmount) {
                                await this.sendTransaction(`Approve ${rwaSymbol} for Router`, tokenContract.approve, [routerAddr, ethers.MaxUint256]);
                                await sleep(2000);
                            }

                            const path = [ethers.getAddress(tokenAddr), targetAddr];
                            const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

                            const success = await this.sendTransaction(
                                `📊 RWA Swap ${rwaSymbol} -> ${targetSymbol}`,
                                routerContract.swapExactTokensForTokens,
                                [swapAmount, 0, path, this.wallet.address, deadline, { gasLimit: 500000 }],
                                true
                            );

                            if (success) {
                                updateDailyStats('swaps', opKey, 1);
                                saveHistory({
                                    timestamp: new Date().toISOString(),
                                    account: `Acc ${this.index + 1}`,
                                    network: netConfig.name,
                                    action: 'RWA_SWAP',
                                    details: `Swapped ${ethers.formatUnits(swapAmount, 18)} ${rwaSymbol} -> ${targetSymbol}`,
                                    status: 'SUCCESS',
                                    txType: 'rwa_swap',
                                    amount: ethers.formatUnits(swapAmount, 18),
                                    fromToken: rwaSymbol,
                                    toToken: targetSymbol,
                                    assetClass: 'RWA'
                                });
                            }
                            await sleep(getRandomDelay(2, 4));
                        }
                    }
                }
            } catch (e) {
                log(this.index, 'WARN', `RWA ${rwaSymbol} error: ${e.message.substring(0, 40)}...`);
            }
        }
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
