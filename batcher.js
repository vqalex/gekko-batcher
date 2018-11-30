const config = require('./config');
const util = require('./util');
require('events').EventEmitter.defaultMaxListeners = 100;
const axios = require('axios');
const promiseLimit = require('promise-limit');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const moment = require('moment');
const math = require('mathjs');
const empty = require('is-empty');
const upperCaseFirst = require('upper-case-first');
const chalk = require('chalk');
const log = console.log;
const {table} = require('table');
const fs = require('fs');
const _ = require('lodash');

let successBacktestCounter = 0;

let httpConfig = {
    headers: {'Content-Type': 'application/json'},
};

/*
* Shuffle generated options for backtests
* */
let shuffle = config.shuffle;

/*
* Basic settings
* */
let gekkoPath = config.gekkoPath;
let apiUrl = config.apiUrl;
let strategiesConfigPath = gekkoPath + 'config/strategies';

let candleSizes = config.candleSizes;
let historySizes = config.historySizes;
let tradingPairs = config.tradingPairs;
let methods = config.methods;
let daterange = config.daterange;
let parallelQueries = config.parallelQueries;

/*
* Collect settings
* */
let options = [];

for (let c = 0; c < candleSizes.length; c++) {
    for (let h = 0; h < historySizes.length; h++) {
        for (let t = 0; t < tradingPairs.length; t++) {
            for (let m = 0; m < methods.length; m++) {
                let option = {
                    candleSize: candleSizes[c],
                    historySize: historySizes[h],
                    tradingPair: {
                        exchange: tradingPairs[t][0],
                        currency: tradingPairs[t][1],
                        asset: tradingPairs[t][2]
                    },
                    method: methods[m]
                };

                /* Get configs for methods from toml files */
                option[methods[m]] = util.getTOML(`${strategiesConfigPath}/${methods[m]}.toml`);

                options.push(option);
            }
        }
    }
}


if (shuffle) {
    options = _.shuffle(options);
}

/*
* Show complete number of combinations
* */
log(options.length + ' ' + 'combinations');

/*
* Get config for backtest function
* */
function getConfig(options, daterange) {
    return {
        "watch": {
            "exchange": options.tradingPair.exchange,
            "currency": options.tradingPair.currency,
            "asset": options.tradingPair.asset
        },
        "paperTrader": {
            "feeMaker": 0.25,
            "feeTaker": 0.25,
            "feeUsing": "maker",
            "slippage": 0.05,
            "simulationBalance": {"asset": 1, "currency": 100},
            "reportRoundtrips": true,
            "enabled": true
        },
        "tradingAdvisor": {
            "enabled": true,
            "method": options.method,
            "candleSize": options.candleSize,
            "historySize": options.historySize
        },
        "backtest": {
            "daterange": {
                "from": daterange.from,
                "to": daterange.to
            }
        },
        "backtestResultExporter": {
            "enabled": true,
            "writeToDisk": false,
            "data": {
                "stratUpdates": false,
                "roundtrips": false,
                "stratCandles": false,
                "stratCandleProps": ["open"],
                "trades": false
            }
        },
        "performanceAnalyzer": {
            "riskFreeReturn": 2,
            "enabled": true
        },
        "valid": true
    };
}

/*
* Collect all settings for batcher
* */
let allConfigs = [];

for (let o = 0; o < options.length; o++) {
    let backtestConfig = getConfig(options[o], daterange);

    backtestConfig[options[o].method] = options[o][options[o].method];

    allConfigs.push(backtestConfig);
}

/*
* Prepare headers and configs for table output in terminal
* */
const tableHeaders = ['Method', 'Currency', 'Asset', 'Candle size', 'History size', 'Exchange', 'Strategy  performance (%)', 'Market performance (%)'];
const tableConfig = {
    columns: {
        3: {
            width: 6,
            wrapWord: true
        },
        4: {
            width: 7,
            wrapWord: true
        },
        6: {
            width: 15,
            wrapWord: true
        },
        7: {
            width: 15,
            wrapWord: true
        },
    }
};

let terminalTable = [];

/*
* Prepare headers for CSV
* */
if (!fs.existsSync('./results')) {
    fs.mkdirSync('./results');
}

const csvWriter = createCsvWriter({
    path: 'results/batch.csv',
    header: [
        {id: 'method', title: 'Method'},
        {id: 'market_performance_percent', title: 'Market performance (%)'},
        {id: 'relative_profit', title: 'Strat performance (%)'},
        {id: 'profit', title: 'Profit'},
        {id: 'run_date', title: 'Run date'},
        {id: 'run_time', title: 'Run time'},
        {id: 'start_date', title: 'Start date'},
        {id: 'end_date', title: 'End date'},
        {id: 'currency_pair', title: 'Currency pair'},
        {id: 'candle_size', title: 'Candle size'},
        {id: 'history_size', title: 'History size'},
        {id: 'currency', title: 'Currency'},
        {id: 'asset', title: 'Asset'},
        {id: 'exchange', title: 'Exchange'},
        {id: 'timespan', title: 'Timespan'},
        {id: 'yearly_profit', title: 'Yearly profit'},
        {id: 'yearly_profit_percent', title: 'Yearly profit (%)'},
        {id: 'start_price', title: 'Start price'},
        {id: 'end_price', title: 'End price'},
        {id: 'trades', title: 'Trades'},
        {id: 'start_balance', title: 'Start balance'},
        {id: 'sharpe', title: 'Sharpe'},
        {id: 'alpha', title: 'Alpha'},
        {id: 'config', title: 'Config'},
        {id: 'downside', title: 'Downside'},
    ]
});

/*
* Run backtests
* */
let limit = promiseLimit(parallelQueries);

Promise.all(allConfigs.map((config) => {
    return limit(function () {
        return runBacktest(config);
    })
})).then(results => {
    if (successBacktestCounter > 0) {
        if (terminalTable.length > 100) {
            log('100 most profitale results:');
        }
        else {
            log('Results:');
        }

        terminalTable.unshift(tableHeaders);

        terminalTable.sort(function (a, b) {
            return b[6] > a[6] ? 1 : -1;
        });

        log(table(terminalTable.slice(0, 100), tableConfig));

        log(chalk.hex('#fafafa').bgHex('#00bf79')('See full results in results/batch.csv'));
    }
    else {
        log(chalk.red('There are no any results'));
    }
});

function runBacktest(config) {
    log(chalk.cyan('Started:', chalk.dim(`${config.tradingAdvisor.method} ${config.watch.currency.toUpperCase()}/${config.watch.asset.toUpperCase()} ${config.tradingAdvisor.candleSize}/${config.tradingAdvisor.historySize} ${upperCaseFirst(config.watch.exchange)}`)));

    process.on('unhandledRejection', (reason, promise) => {
        log('Unhandled Rejection at:', reason.stack || reason)
    })

    return new Promise(function (resolve) {
        axios.post(`${apiUrl}/api/backtest`, config, httpConfig).then((response) => {
            let market = response.data.market;
            let tradingAdvisor = response.data.tradingAdvisor;
            let strategyParameters = response.data.strategyParameters;
            let performanceReport = response.data.performanceReport;

            let resultCsvLine = [];

            if (empty(tradingAdvisor) || empty(performanceReport)) {
                log(chalk.red('No trades for:', chalk.dim(`${config.tradingAdvisor.method} ${config.watch.currency.toUpperCase()}/${config.watch.asset.toUpperCase()} ${config.tradingAdvisor.candleSize}/${config.tradingAdvisor.historySize} ${upperCaseFirst(config.watch.exchange)}`)));
                resolve();
            }
            else {
                successBacktestCounter++;

                resultCsvLine = [{
                    method: tradingAdvisor.method,
                    market_performance_percent: util.round(performanceReport.market),
                    relative_profit: util.round(performanceReport.relativeProfit),
                    profit: util.round(performanceReport.profit),
                    run_date: moment().utc().format('ll'),
                    run_time: moment().utc().format('LT'),
                    start_date: util.humanizeDate(performanceReport.startTime),
                    end_date: util.humanizeDate(performanceReport.endTime),
                    currency_pair: (market.currency + '/' + market.asset).toUpperCase(),
                    candle_size: tradingAdvisor.candleSize,
                    history_size: tradingAdvisor.historySize,
                    currency: market.currency.toUpperCase(),
                    asset: market.asset.toUpperCase(),
                    exchange: market.exchange,
                    timespan: performanceReport.timespan,
                    yearly_profit: util.round(performanceReport.relativeProfit),
                    yearly_profit_percent: util.round(performanceReport.yearlyProfit),
                    start_price: performanceReport.startPrice,
                    end_price: performanceReport.endPrice,
                    trades: performanceReport.trades,
                    start_balance: performanceReport.startBalance,
                    sharpe: util.round(performanceReport.sharpe, 3),
                    alpha: util.round(performanceReport.alpha, 3),
                    config: JSON.stringify(strategyParameters),
                    downside: util.round(performanceReport.downside, 3)
                }];

                terminalTable.push([
                    tradingAdvisor.method,
                    market.currency.toUpperCase(),
                    market.asset.toUpperCase(),
                    tradingAdvisor.candleSize,
                    tradingAdvisor.historySize,
                    market.exchange,
                    util.round(performanceReport.relativeProfit),
                    util.round(performanceReport.market)
                ])

                Promise.resolve()
                    .then(function () {
                        return csvWriter.writeRecords(resultCsvLine);
                    })
                    .then(() => {
                        log(chalk.green('Complete:', chalk.dim(`${config.tradingAdvisor.method} ${config.watch.currency.toUpperCase()}/${config.watch.asset.toUpperCase()} ${config.tradingAdvisor.candleSize}/${config.tradingAdvisor.historySize} ${upperCaseFirst(config.watch.exchange)}`)));
                        resolve();
                    });
            }
        }).catch(function (error) {
            log(error);
        })
    })
}