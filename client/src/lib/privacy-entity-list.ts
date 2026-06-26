/**
   * Offline curated entity list for KYUTXO Privacy Audit.
   *
   * This is a curated dataset stored entirely in-repo — no external CDN, no
   * remote fetch, no third-party package, and nothing is requested at runtime.
   * Every entry carries a `sourceNote` citing the public attribution it came
   * from (informational only — the URLs are never fetched by the app).
   *
   * Public sources used:
   *  - WalletExplorer.com service address clustering (exchanges, services,
   *    gambling, mixers, mining pools, darknet markets).
   *  - GraphSense open-source TagPacks (https://github.com/graphsense/graphsense-tagpacks)
   *    for darknet markets, ransomware, ponzi, sextortion and sanctioned entities.
   *  - U.S. Treasury OFAC SDN designations for sanctioned mixers / markets / groups.
   *  - Security-research datasets (Cisco Talos, Paquet-Clouston et al., academic
   *    ponzi corpora) and well-documented incident reports.
   *
   * Structure: address → entity metadata. A Map gives O(1) exact-address lookup
   * so the caller never iterates the whole list per participant address.
   */

  export type EntityCategory =
    | 'exchange'
    | 'payment-service'
    | 'gambling'
    | 'scam'
    | 'darknet'
    | 'mining-pool'
    | 'mixer'
    | 'p2p-exchange';

  export interface EntityEntry {
    address: string;
    name: string;
    category: EntityCategory;
    /** Public source confirming attribution (informational only, never fetched) */
    sourceNote?: string;
  }

  /**
   * Publicly documented Bitcoin addresses by category. All attributions are drawn
   * from public, verifiable sources (see file header) and stored offline.
   * Scam / darknet / sanctioned entries are clearly marked with public evidence
   * links in their `sourceNote`.
   */
  export const ENTITY_LIST: EntityEntry[] = [
  // ── Exchanges ───────────────────────────────────────────────────
  { address: "1EdiJAgeX91JvVie2LbHgNXhP4pdMxAUdn", name: "796", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1EdiJAgeX91JvVie2LbHgNXhP4pdMxAUdn" },
  { address: "1A5uojZdwuf5TUApwzcFQ2XvnSKb91hHJv", name: "Banx", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1A5uojZdwuf5TUApwzcFQ2XvnSKb91hHJv" },
  { address: "1LRGtCGbJQNqmCBs3mmCdWdTCcEZBjDVf4", name: "Banx", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1LRGtCGbJQNqmCBs3mmCdWdTCcEZBjDVf4" },
  { address: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo", name: "Binance", category: "exchange", sourceNote: "Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)" },
  { address: "bc1ql42rmpvvq488tkqxvg8wmaa7j3jsrkxgnm8cy6", name: "Binance", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/bc1ql42rmpvvq488tkqxvg8wmaa7j3jsrkxgnm8cy6" },
  { address: "16ftSEQ4ctQFDtVZiUBusQUjRrGhM3JYwe", name: "Binance", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/16ftSEQ4ctQFDtVZiUBusQUjRrGhM3JYwe" },
  { address: "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s", name: "Binance Cold Wallet", category: "exchange", sourceNote: "Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)" },
  { address: "34UmEXBUdBb4PcSZt6s2uJRHcyEBS5FJfc", name: "Bit-x", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/34UmEXBUdBb4PcSZt6s2uJRHcyEBS5FJfc" },
  { address: "13ozh1W6FDf8vtFsaLxTJtZgKtWm2WYBZC", name: "BitBargain.co.uk", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/13ozh1W6FDf8vtFsaLxTJtZgKtWm2WYBZC" },
  { address: "14ubK5amkDXXHwXNKCxUfTxC8wsq12134r", name: "BitBay", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/14ubK5amkDXXHwXNKCxUfTxC8wsq12134r" },
  { address: "1FjjzDjrvpc9vP3xnPmjJs2AUFnMQiKaCy", name: "Bitcoin.de", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1FjjzDjrvpc9vP3xnPmjJs2AUFnMQiKaCy" },
  { address: "1MyQmLuSxsdBcCpZXEdBE1eTCdYQk4toK9", name: "Bitcoin.de", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1MyQmLuSxsdBcCpZXEdBE1eTCdYQk4toK9" },
  { address: "12HLwCH3haK8nA8J7hGtraxM3PgjXyt48a", name: "BitcoinVietnam.com.vn", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/12HLwCH3haK8nA8J7hGtraxM3PgjXyt48a" },
  { address: "18SvPRMG3o6DWAcQPgvDZRr3VSnACR5pfZ", name: "Bitcurex", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/18SvPRMG3o6DWAcQPgvDZRr3VSnACR5pfZ" },
  { address: "1129A9dFqy4ABDsGQ8RGusbMWYBoZc4myc", name: "Bitfinex", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1129A9dFqy4ABDsGQ8RGusbMWYBoZc4myc" },
  { address: "1HPM1sNGef6Hq3YYd2hYQkpnRhQkkaWGVK", name: "Bitfinex", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1HPM1sNGef6Hq3YYd2hYQkpnRhQkkaWGVK" },
  { address: "1Kr6QSydW9bFQG1mXiPNNu6WpJGmUa9i1g", name: "Bitfinex Hot Wallet", category: "exchange", sourceNote: "Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)" },
  { address: "19xL684pZ2LjUQecg2sRgCuiapSCWutZXd", name: "BitKonan", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/19xL684pZ2LjUQecg2sRgCuiapSCWutZXd" },
  { address: "1JRij36KPEyusBNdUtwZZSmgqMd7aRiXYZ", name: "Bitso", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1JRij36KPEyusBNdUtwZZSmgqMd7aRiXYZ" },
  { address: "12cgpFdJViXbwHbhrA3TuW1EGnL25Zqc3P", name: "Bitstamp", category: "exchange", sourceNote: "Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)" },
  { address: "3Fh9p2W79ZHG54ettRJupkPTs23XcjrkT2", name: "Bitstamp", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/3Fh9p2W79ZHG54ettRJupkPTs23XcjrkT2" },
  { address: "19jQz2ajiCN1hmavUkCrxKWnZwCfhQgJ9e", name: "Bitstamp", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/19jQz2ajiCN1hmavUkCrxKWnZwCfhQgJ9e" },
  { address: "1JoFwz68wWLPHmEBeiBHA9XkanVLcWALNt", name: "Bittrex", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1JoFwz68wWLPHmEBeiBHA9XkanVLcWALNt" },
  { address: "1AggqtjcbkBwvrRFn3Vb3j8itR9cHJziCW", name: "BitVC", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1AggqtjcbkBwvrRFn3Vb3j8itR9cHJziCW" },
  { address: "1AeTnARKQhdp8MMYk7LiRTnoJURwjgD7SN", name: "BitZlato", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1AeTnARKQhdp8MMYk7LiRTnoJURwjgD7SN" },
  { address: "1Js5P9JVjTgPWfhf7xvWQB47jBZ4LbxBtj", name: "Bleutrade", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Js5P9JVjTgPWfhf7xvWQB47jBZ4LbxBtj" },
  { address: "1BfnVVzcWpToA2uEcgt9n7LiTUGpC8DAt1", name: "BlockTrades", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1BfnVVzcWpToA2uEcgt9n7LiTUGpC8DAt1" },
  { address: "13hejvFY71WzJN3yAwcTDZpvAA35a6DruE", name: "BTC-e", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/13hejvFY71WzJN3yAwcTDZpvAA35a6DruE" },
  { address: "13xcqLTZYxaxYb1q4cnaKcYrTTGnpFiZ3e", name: "Btc38", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/13xcqLTZYxaxYb1q4cnaKcYrTTGnpFiZ3e" },
  { address: "175bAuvzF6iE5YN1B9AB2LZZoiqEgTjnhN", name: "BTCC", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/175bAuvzF6iE5YN1B9AB2LZZoiqEgTjnhN" },
  { address: "19RvvJxhLz9BNNQPgVgGQ6XhL9VCGoHthg", name: "BTCC", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/19RvvJxhLz9BNNQPgVgGQ6XhL9VCGoHthg" },
  { address: "15cNN9rkvbNjKTKppYuCHwJDEXMeghUrC4", name: "BtcMarkets", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/15cNN9rkvbNjKTKppYuCHwJDEXMeghUrC4" },
  { address: "1CtV38vefpRDJXo6GwpmYr73e9XsNs6LG4", name: "BtcTrade", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1CtV38vefpRDJXo6GwpmYr73e9XsNs6LG4" },
  { address: "14Hs9wrbKRBzmHXwasKs9KFVzRfa4Zr3KC", name: "Bter", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/14Hs9wrbKRBzmHXwasKs9KFVzRfa4Zr3KC" },
  { address: "14Fg9xfaNi5pcLD8WJpQEKiEiCB4vwjYYd", name: "Bter", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/14Fg9xfaNi5pcLD8WJpQEKiEiCB4vwjYYd" },
  { address: "12HzwqW7tH1Mf9SpiyyQwj8bJfXb2jVkDY", name: "BTradeAustralia", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/12HzwqW7tH1Mf9SpiyyQwj8bJfXb2jVkDY" },
  { address: "1DP9ESTJFbmkCPEpcJwAx4i1XMP3jk1W8Q", name: "BX.in.th", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1DP9ESTJFbmkCPEpcJwAx4i1XMP3jk1W8Q" },
  { address: "18xNZC5xNC4H9zfQui949r4CPPAexJPPDq", name: "C-Cex", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/18xNZC5xNC4H9zfQui949r4CPPAexJPPDq" },
  { address: "12sfMXwNtTkWTvk6aPWzxRKmnzgsPCwuLK", name: "C-Cex", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/12sfMXwNtTkWTvk6aPWzxRKmnzgsPCwuLK" },
  { address: "1GLTa4dVQzM4SfwXRsr5LCtYwR2ttKmxAV", name: "CampBX", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1GLTa4dVQzM4SfwXRsr5LCtYwR2ttKmxAV" },
  { address: "1LWYWLoLDJp63D4wP6QPy9egad9y2xZCxU", name: "CampBX", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1LWYWLoLDJp63D4wP6QPy9egad9y2xZCxU" },
  { address: "1NN7YrRe9muJM4XZLpNd6vwsYRRkEaMqaE", name: "Cavirtex", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1NN7YrRe9muJM4XZLpNd6vwsYRRkEaMqaE" },
  { address: "19FConZdZrhKEat2hgjfpZDPouqXde8Eq5", name: "Ccedk", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/19FConZdZrhKEat2hgjfpZDPouqXde8Eq5" },
  { address: "1GwePtfuQKtV8YfUADi77RDVX5YKxNbFmp", name: "Cex", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1GwePtfuQKtV8YfUADi77RDVX5YKxNbFmp" },
  { address: "1M9uRdnapve2E2qkka737dwgZceQwKA5sh", name: "ChBtc", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1M9uRdnapve2E2qkka737dwgZceQwKA5sh" },
  { address: "1Pay5KuWjYkefTvSLQ6E6rsB8ompgKaRF", name: "CleverCoin", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Pay5KuWjYkefTvSLQ6E6rsB8ompgKaRF" },
  { address: "1FpZLEspFZ6TRUr3bZbSnjPj2y6SD5dEoF", name: "CoinArch", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1FpZLEspFZ6TRUr3bZbSnjPj2y6SD5dEoF" },
  { address: "3D2oetdNuZUqQHPJmcMDDHYoqkyNVsFk9r", name: "Coinbase (custody)", category: "exchange", sourceNote: "Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)" },
  { address: "1Djjej8xaufZqwA7tT2vA6siiADsqiysFg", name: "Coinbroker", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Djjej8xaufZqwA7tT2vA6siiADsqiysFg" },
  { address: "1GgwvpxYDUNRQkvdMSsXBz8yhCKcHurCv8", name: "CoinCafe", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1GgwvpxYDUNRQkvdMSsXBz8yhCKcHurCv8" },
  { address: "17W4PZ2PS3KksDy5T6yE7FaJsgjmnYMXuP", name: "CoinCafe", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/17W4PZ2PS3KksDy5T6yE7FaJsgjmnYMXuP" },
  { address: "13R9RgUsPb4qfx3V3E5kQRQvvvpjyuf24U", name: "CoinChimp", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/13R9RgUsPb4qfx3V3E5kQRQvvvpjyuf24U" },
  { address: "1QJa4Lp3cEAZuXwGpryizdaEbFE2Y7wmer", name: "Coingi", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1QJa4Lp3cEAZuXwGpryizdaEbFE2Y7wmer" },
  { address: "37Gq87Ni5XAuPGuzGwVsrftsTCimNdWjJA", name: "CoinHako", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/37Gq87Ni5XAuPGuzGwVsrftsTCimNdWjJA" },
  { address: "1MLgaxVMmhscDAN3Mjg1wPYNvSAG4mMDbf", name: "Coinimal", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1MLgaxVMmhscDAN3Mjg1wPYNvSAG4mMDbf" },
  { address: "1Q33qtdzSmnuw1PKXUrUfA2eGSG7mBdhT8", name: "Coinmate", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Q33qtdzSmnuw1PKXUrUfA2eGSG7mBdhT8" },
  { address: "1P73v4KZjFwqrm8jep4UQQcFHHFjER6S4J", name: "CoinMotion", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1P73v4KZjFwqrm8jep4UQQcFHHFjER6S4J" },
  { address: "1PBpVk1UJs5baR4rLLt21FA4J3c4dm74Tz", name: "Coinomat", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1PBpVk1UJs5baR4rLLt21FA4J3c4dm74Tz" },
  { address: "1QEZAwpeQ8tCVWjg3iWty4A9rWu6uqsdfW", name: "Coins-e", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1QEZAwpeQ8tCVWjg3iWty4A9rWu6uqsdfW" },
  { address: "1QEJi2srHeHnqBK1RhDw2BKz8Aucm8bnVr", name: "CoinSpot.com.au", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1QEJi2srHeHnqBK1RhDw2BKz8Aucm8bnVr" },
  { address: "1N2PpfzKEQ2GvgCieQrBBX85Jn66h7ygKp", name: "Cryptonit", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1N2PpfzKEQ2GvgCieQrBBX85Jn66h7ygKp" },
  { address: "17ScNZRH8Po8vsdePDY25KaDgd4EjYkdMq", name: "Cryptonit", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/17ScNZRH8Po8vsdePDY25KaDgd4EjYkdMq" },
  { address: "1Empt7dGo7ZR7QemR2mBon6NdbLa4tMaSU", name: "Cryptsy", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Empt7dGo7ZR7QemR2mBon6NdbLa4tMaSU" },
  { address: "191iQZd1aYxxTNNDYGY4SGBjvvNV4pDZTf", name: "Cryptsy", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/191iQZd1aYxxTNNDYGY4SGBjvvNV4pDZTf" },
  { address: "3Nrm8YHo6sbqzJd7Qwbj16gLL1N6r55XZy", name: "Cubits", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/3Nrm8YHo6sbqzJd7Qwbj16gLL1N6r55XZy" },
  { address: "12gCdrdTRnRXxJvpVoSzvZKoabpuwbup1y", name: "EmpoEX", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/12gCdrdTRnRXxJvpVoSzvZKoabpuwbup1y" },
  { address: "1Q7PTybd4ybhKAi8a9pph6NjVCEMVfUhBt", name: "Exchange-Credit.ru", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Q7PTybd4ybhKAi8a9pph6NjVCEMVfUhBt" },
  { address: "1Ks5aLkREyVUba3QiS64ZL5PPdcgXDXhBp", name: "Exchanging.ir", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Ks5aLkREyVUba3QiS64ZL5PPdcgXDXhBp" },
  { address: "13qt1ipJ8i9sXnRAPtjiDqSdnf8deriKPn", name: "Exmo", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/13qt1ipJ8i9sXnRAPtjiDqSdnf8deriKPn" },
  { address: "12RZE3EXnzjcydQkhHX3pLriLxSEH9xpM6", name: "FoxBit.com.br", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/12RZE3EXnzjcydQkhHX3pLriLxSEH9xpM6" },
  { address: "1CcQjmpete8MJsXXLB9xUBvYxFxM5aoFug", name: "FoxBit.com.br", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1CcQjmpete8MJsXXLB9xUBvYxFxM5aoFug" },
  { address: "1FP7hmpYcKuokNhDSof6do4HMMHTgVSmXb", name: "FYBSG", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1FP7hmpYcKuokNhDSof6do4HMMHTgVSmXb" },
  { address: "1B9Zn2hn7k73SoxnJjVzYdT68YWfatA2jT", name: "Gatecoin", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1B9Zn2hn7k73SoxnJjVzYdT68YWfatA2jT" },
  { address: "1LEUTU5szxXwMjfZYDGQQB7yvMjs3v7cqV", name: "Gatecoin", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1LEUTU5szxXwMjfZYDGQQB7yvMjs3v7cqV" },
  { address: "1HQ3Go3ggs8pFnXuHVHRytPCq5fGG8Hbhx", name: "Gemini", category: "exchange", sourceNote: "Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)" },
  { address: "1PgSXhDrZf93s7qJt4kLm3knNda8uafkdN", name: "HappyCoins", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1PgSXhDrZf93s7qJt4kLm3knNda8uafkdN" },
  { address: "15NqUTYyUegiPrkd573JUNn4e8vsZ9SGBq", name: "Hashnest", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/15NqUTYyUegiPrkd573JUNn4e8vsZ9SGBq" },
  { address: "19n49Jd8qN5zoKCoQhNMBbTZ3KPa5q7peD", name: "HitBtc", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/19n49Jd8qN5zoKCoQhNMBbTZ3KPa5q7peD" },
  { address: "19W1qPcx2addfmSRsRem6rFVLpnvd41A1P", name: "HitBtc", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/19W1qPcx2addfmSRsRem6rFVLpnvd41A1P" },
  { address: "1P5ZEDWTKTFGxQjZphgWPQUpe554WKDfHQ", name: "Huobi", category: "exchange", sourceNote: "Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)" },
  { address: "1vdXJDiDSzeUAoM7eAcWZPhM9wEKmH8dG", name: "Huobi", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1vdXJDiDSzeUAoM7eAcWZPhM9wEKmH8dG" },
  { address: "1H3nwrL8acJDhejt2mW7ianBrQtTw9LTvn", name: "Huobi", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1H3nwrL8acJDhejt2mW7ianBrQtTw9LTvn" },
  { address: "13AQEQcXhReiyxgF7inksknkdCAmoxm8mD", name: "Igot", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/13AQEQcXhReiyxgF7inksknkdCAmoxm8mD" },
  { address: "1KhAnwCKmky1JV9De1SidddbV2PWgNA1jK", name: "Indacoin", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1KhAnwCKmky1JV9De1SidddbV2PWgNA1jK" },
  { address: "1PMCE8CS9MRy4pKuHSNSij9dyAAA5hfMAH", name: "Korbit.co.kr", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1PMCE8CS9MRy4pKuHSNSij9dyAAA5hfMAH" },
  { address: "3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6", name: "Kraken", category: "exchange", sourceNote: "Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)" },
  { address: "3G3VG4X1WquWjqXT27JRwrRoyZgdyWf1dT", name: "Kraken", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/3G3VG4X1WquWjqXT27JRwrRoyZgdyWf1dT" },
  { address: "196pUYs6kGpwii2KjV138SXrJ2hwKLaMVr", name: "Kraken", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/196pUYs6kGpwii2KjV138SXrJ2hwKLaMVr" },
  { address: "1FzWLkAahHooV3kzTgyx6qsswXJ6sCXkSR", name: "Kucoin", category: "exchange", sourceNote: "Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)" },
  { address: "1JEbMUo2EbaSHqVaF8dhccXTsjSVr1R2x2", name: "LakeBTC", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1JEbMUo2EbaSHqVaF8dhccXTsjSVr1R2x2" },
  { address: "129Ny4AeMDVHjm7A319BA6FRnoudDqYmiF", name: "LiteBit", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/129Ny4AeMDVHjm7A319BA6FRnoudDqYmiF" },
  { address: "14whipLwqHE8LYQKHUim6egLVNp4sjbzT1", name: "Luno", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/14whipLwqHE8LYQKHUim6egLVNp4sjbzT1" },
  { address: "16EoTzqH35sRViCPirUhCMQFkwZr5krkgC", name: "MaiCoin", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/16EoTzqH35sRViCPirUhCMQFkwZr5krkgC" },
  { address: "12UpN72E5MyU1quSPVHnhquTVy81Jpfd3q", name: "Matbea", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/12UpN72E5MyU1quSPVHnhquTVy81Jpfd3q" },
  { address: "3L1smrPn5chgVCehpUhvs5h5nJGxGQe6sD", name: "MercadoBitcoin.com.br", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/3L1smrPn5chgVCehpUhvs5h5nJGxGQe6sD" },
  { address: "1KNsnY427p1hEAisSEcbCi1a9YLA6WK8P8", name: "MeXBT", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1KNsnY427p1hEAisSEcbCi1a9YLA6WK8P8" },
  { address: "1JdXuWHRrVPTRkesF7mwBBGoHiBfvH2aiZ", name: "OKCoin", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1JdXuWHRrVPTRkesF7mwBBGoHiBfvH2aiZ" },
  { address: "159kpiQjEuEVmcMXGGhsjUC13RHcEcNNJo", name: "OKCoin", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/159kpiQjEuEVmcMXGGhsjUC13RHcEcNNJo" },
  { address: "1BjtiSPSTecqikZhSjRPY7AZfbubgTA4nD", name: "OrderBook", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1BjtiSPSTecqikZhSjRPY7AZfbubgTA4nD" },
  { address: "17Jhdq75dX77ZdkVQrcozMXd54WGHAxrw", name: "Poloniex", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/17Jhdq75dX77ZdkVQrcozMXd54WGHAxrw" },
  { address: "16xAAvXw4H2m2i1ASEeTAfg4sMVbWGBYkc", name: "QuadrigaCX", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/16xAAvXw4H2m2i1ASEeTAfg4sMVbWGBYkc" },
  { address: "13N69SPqEJTLNDH3v4d4Ux7nZsABRyhpur", name: "SimpleCoin.cz", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/13N69SPqEJTLNDH3v4d4Ux7nZsABRyhpur" },
  { address: "1927zCBQXa6nG4ZaTDNtaek4ubHpEbJGxP", name: "SimpleCoin.cz", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1927zCBQXa6nG4ZaTDNtaek4ubHpEbJGxP" },
  { address: "1AjxBHA34yLCnbsDhwPiYdio6op1XcnrYa", name: "SpectroCoin", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1AjxBHA34yLCnbsDhwPiYdio6op1XcnrYa" },
  { address: "33BibcTnn55sseWxYirQ9cdvNxs356sZ4L", name: "TheRockTrading", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/33BibcTnn55sseWxYirQ9cdvNxs356sZ4L" },
  { address: "32fKWz4NuWmig5qda1KCXqEcQH1sVBNMyP", name: "TheRockTrading", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/32fKWz4NuWmig5qda1KCXqEcQH1sVBNMyP" },
  { address: "1Ch7SkX8n1PLJPR5aCu6uAs441iRuMLT4T", name: "UseCryptos", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Ch7SkX8n1PLJPR5aCu6uAs441iRuMLT4T" },
  { address: "1Jyw4Zkn7BYXQRDniiSi3WBNq6PucEgiY3", name: "Vaultoro", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Jyw4Zkn7BYXQRDniiSi3WBNq6PucEgiY3" },
  { address: "1Aa9tZ6ktDVSTp4sJdyZsVFbmVGceAKAuc", name: "Vircurex", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Aa9tZ6ktDVSTp4sJdyZsVFbmVGceAKAuc" },
  { address: "15hqpeJGFECgSQqsYm2AYN37nNfwUPkQf8", name: "VirWoX", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/15hqpeJGFECgSQqsYm2AYN37nNfwUPkQf8" },
  { address: "337RfngTLRTpU7RT9sKWQWDdmfcdmWnugi", name: "Xapo", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/337RfngTLRTpU7RT9sKWQWDdmfcdmWnugi" },
  { address: "16Uis1fhMgwJfQFAYBhBA2arocySbQ3WbN", name: "YoBit", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/16Uis1fhMgwJfQFAYBhBA2arocySbQ3WbN" },
  { address: "1EWcssKiXkADhmh4afNCNCWYzKSPQK1761", name: "Zyado", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1EWcssKiXkADhmh4afNCNCWYzKSPQK1761" },
  { address: "12pw1MoNhGw18cP5Kn4drdWPbndD2jnAEU", name: "Zyado", category: "exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/12pw1MoNhGw18cP5Kn4drdWPbndD2jnAEU" },

  // ── Payment / Wallet Services ───────────────────────────────────
  { address: "16RtSf2McLsAewZGy3DWDSLGqZMJS9BVeK", name: "10xBitco", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/16RtSf2McLsAewZGy3DWDSLGqZMJS9BVeK" },
  { address: "1PaGc2CUvmS8W3qxELxcehzyughnDVyVH5", name: "50BTC", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1PaGc2CUvmS8W3qxELxcehzyughnDVyVH5" },
  { address: "198i5jrY1B4xGnQwbiDVuQzcq17thzaH1s", name: "50BTC", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/198i5jrY1B4xGnQwbiDVuQzcq17thzaH1s" },
  { address: "1CmBsU9zR3HYsv6hMEqMpjZ7yYF8H6DznY", name: "ActionCrypto", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1CmBsU9zR3HYsv6hMEqMpjZ7yYF8H6DznY" },
  { address: "12X7NuzuSNQpQwmcXkQwUKp9oXx51Ea2FB", name: "AdmiralCoin", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/12X7NuzuSNQpQwmcXkQwUKp9oXx51Ea2FB" },
  { address: "166J5Rppb6v36LunHFTaKycFsZfNMhsNBa", name: "AllCoin", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/166J5Rppb6v36LunHFTaKycFsZfNMhsNBa" },
  { address: "1EMgTErvxqcKFi6gkMnmyvTRxWrgD2dnDk", name: "AllCrypt", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1EMgTErvxqcKFi6gkMnmyvTRxWrgD2dnDk" },
  { address: "1NyZo89LWsnAfbWoZ3kymebcKpdWXUsWGB", name: "ASICMiner", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1NyZo89LWsnAfbWoZ3kymebcKpdWXUsWGB" },
  { address: "1Bet56kWEpCq8ugG9tqAkLNXqaAQ4eUALp", name: "BetcoinDice.tm", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Bet56kWEpCq8ugG9tqAkLNXqaAQ4eUALp" },
  { address: "14CL3a7xwcFr9ed34v95p9J8w9dcrC6E5U", name: "Betcoins", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/14CL3a7xwcFr9ed34v95p9J8w9dcrC6E5U" },
  { address: "1H3pTUTVKRxpDKezfubjAJoxSGqCfgB9W4", name: "BetsOfBitco", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1H3pTUTVKRxpDKezfubjAJoxSGqCfgB9W4" },
  { address: "1FqL6bbHgLLKgmKhoqBrmzRtCBHhw4Xgn9", name: "BitAces", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1FqL6bbHgLLKgmKhoqBrmzRtCBHhw4Xgn9" },
  { address: "1Gkrccykb4yNkCM3nAs6q5CJKfq8bC8Kth", name: "BitAces", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Gkrccykb4yNkCM3nAs6q5CJKfq8bC8Kth" },
  { address: "131BxXXEvuEBzwkVPv36EWsoHWzKuXr6Rn", name: "Bitbond", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/131BxXXEvuEBzwkVPv36EWsoHWzKuXr6Rn" },
  { address: "1J5DbUnxn25s5s3ZcM3bzGSuMkgxHSoCCY", name: "Bitcash.cz", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1J5DbUnxn25s5s3ZcM3bzGSuMkgxHSoCCY" },
  { address: "13Fes87EQbbGgCmpT3nGTeL2LSnWPcrZzb", name: "BitClix", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/13Fes87EQbbGgCmpT3nGTeL2LSnWPcrZzb" },
  { address: "12AJNRZ6Ct3kgQHanT3pUigjNUHJNFAdiQ", name: "Bitcoin-24", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/12AJNRZ6Ct3kgQHanT3pUigjNUHJNFAdiQ" },
  { address: "12ha5LUjqq18MzCQDT3RyqjPMN9zjkB8SG", name: "Bitcoin-24", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/12ha5LUjqq18MzCQDT3RyqjPMN9zjkB8SG" },
  { address: "1Num28t7MtuKkES4nviZhtjwt8R6N17CBX", name: "Bitcoin-Roulette", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Num28t7MtuKkES4nviZhtjwt8R6N17CBX" },
  { address: "19WsmzLuZW25WtvGLmhzVjCcRDf4KAmjYz", name: "Bitcoinica", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/19WsmzLuZW25WtvGLmhzVjCcRDf4KAmjYz" },
  { address: "1M9SmrPPCvNEKf7guVLCWbYAmctoRTga4x", name: "Bitcoinica", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1M9SmrPPCvNEKf7guVLCWbYAmctoRTga4x" },
  { address: "14xGktVgDJaDrSSJnF15d2kwXpwyeG3J2D", name: "BitcoinWallet", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/14xGktVgDJaDrSSJnF15d2kwXpwyeG3J2D" },
  { address: "1KePeYZbB3G96y7N3xwdviq4Xk5QUB1vrW", name: "BitcoinWeBank", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1KePeYZbB3G96y7N3xwdviq4Xk5QUB1vrW" },
  { address: "1CBG46uY2KrYodgbMh7Xpna4bGHu2BNnMK", name: "BitElfin", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1CBG46uY2KrYodgbMh7Xpna4bGHu2BNnMK" },
  { address: "171Mu3bBKQ9yBMjafJLEGEPKkNQAVeJj6R", name: "BitMillions", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/171Mu3bBKQ9yBMjafJLEGEPKkNQAVeJj6R" },
  { address: "1MBrBQWfQeD9w15JVCdkw1egCGVYmQ1Mi5", name: "Bitmit", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1MBrBQWfQeD9w15JVCdkw1egCGVYmQ1Mi5" },
  { address: "19zWBh7iS8aaB2mkTLMkw2hz1fMQoHsYqW", name: "BitNZ", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/19zWBh7iS8aaB2mkTLMkw2hz1fMQoHsYqW" },
  { address: "18x18ZoDXLTEtWrM8m258wze3Ne3ktQzTZ", name: "BitoEX", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/18x18ZoDXLTEtWrM8m258wze3Ne3ktQzTZ" },
  { address: "1HVnhAshA2HT5fpsfUtarZM2qkBKD6aUmM", name: "BIToomBa", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1HVnhAshA2HT5fpsfUtarZM2qkBKD6aUmM" },
  { address: "1Cnc6HdErHyxmMXn8i8k9RWQDVCoM52BNv", name: "BitPay", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Cnc6HdErHyxmMXn8i8k9RWQDVCoM52BNv" },
  { address: "1LrEDfQr96WbaySJtqBXHbckgpaHPFs91e", name: "BitPay", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1LrEDfQr96WbaySJtqBXHbckgpaHPFs91e" },
  { address: "1KCL6vv1vm1sxb6UdkTXcQbXtgRdigeiyd", name: "BitYes", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1KCL6vv1vm1sxb6UdkTXcQbXtgRdigeiyd" },
  { address: "1McGKcYG228cfuTECQ3J7qfn4VU7a2Xxp4", name: "Brawker", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1McGKcYG228cfuTECQ3J7qfn4VU7a2Xxp4" },
  { address: "1BTCDicei8W5eHzLzv1eqzfSGhhinNqkzd", name: "BtcDice", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1BTCDicei8W5eHzLzv1eqzfSGhhinNqkzd" },
  { address: "1Dmc1cdaeE6adH8FKVPNreEqTwMqCidNas", name: "BtcExchange.ro", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Dmc1cdaeE6adH8FKVPNreEqTwMqCidNas" },
  { address: "1PsbZbPCFuLSuqfyftGhTUbuxybYhCTpEP", name: "BTCGuild", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1PsbZbPCFuLSuqfyftGhTUbuxybYhCTpEP" },
  { address: "1FBdATuiou5nC13tGBAXfSQNMJ1NE92Tb6", name: "BTCJam", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1FBdATuiou5nC13tGBAXfSQNMJ1NE92Tb6" },
  { address: "1J2n69nCj3c1sFjKxxW1w7ytkNwXW6ym2w", name: "BTCLend", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1J2n69nCj3c1sFjKxxW1w7ytkNwXW6ym2w" },
  { address: "135J3XAVdDvCadgidoZsGx6tWpemQkVAA8", name: "BTCPop", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/135J3XAVdDvCadgidoZsGx6tWpemQkVAA8" },
  { address: "1HDG83XDDDb5D8koLD5y8M8vx3UfnraLY8", name: "Btcst.com-pirateat40", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1HDG83XDDDb5D8koLD5y8M8vx3UfnraLY8" },
  { address: "1L59UBU5Ve7N2bGdxoMNxcXnz8pkyXk6sK", name: "BTCt", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1L59UBU5Ve7N2bGdxoMNxcXnz8pkyXk6sK" },
  { address: "12nWEXvsZ9UMnkun54TDR7xnQPnLibFe4o", name: "Bylls", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/12nWEXvsZ9UMnkun54TDR7xnQPnLibFe4o" },
  { address: "1J17B4Vd4Ueehf6ESjrMFJtapoZbJ51gxB", name: "Chainroll", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1J17B4Vd4Ueehf6ESjrMFJtapoZbJ51gxB" },
  { address: "1ChainN1SGSsWSpkEfBDCVaFPmTfGtB52j", name: "Chainroll", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1ChainN1SGSsWSpkEfBDCVaFPmTfGtB52j" },
  { address: "16reEBPhkZdMyLSsQFanCFq5tU6EbaJ5aj", name: "ChangeTip", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/16reEBPhkZdMyLSsQFanCFq5tU6EbaJ5aj" },
  { address: "19WAMAnJXfeZaZZiXyqLqLARJVZM9fuhbD", name: "ChangeTip", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/19WAMAnJXfeZaZZiXyqLqLARJVZM9fuhbD" },
  { address: "1HCj6GTidAQTKLYMazYS1cyQbPHsLheVjt", name: "CloudHashing", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1HCj6GTidAQTKLYMazYS1cyQbPHsLheVjt" },
  { address: "1NbJcTdsDwUH3TNjnsDX3zXGSCXnVSUXrR", name: "Coin-Swap", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1NbJcTdsDwUH3TNjnsDX3zXGSCXnVSUXrR" },
  { address: "15cqTaE1bsMU1pdkzPirEVbQdTV3qWD3kR", name: "Coin-Sweeper", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/15cqTaE1bsMU1pdkzPirEVbQdTV3qWD3kR" },
  { address: "1DrWFD46eUZH6HF24fMAKFygwvteXekq5W", name: "Coin.mx", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1DrWFD46eUZH6HF24fMAKFygwvteXekq5W" },
  { address: "3GoYLfZnLfCRkNsC8Wpdw2GGC2LnMAgaYm", name: "CoinApult", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/3GoYLfZnLfCRkNsC8Wpdw2GGC2LnMAgaYm" },
  { address: "15KFH9B24dVuJdHdpDeUD6eRUd9UQHTBxw", name: "CoinApult", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/15KFH9B24dVuJdHdpDeUD6eRUd9UQHTBxw" },
  { address: "1cointQVgw2EwnJx3EFVPvD65gSsD9nJ7", name: "CoinBox", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1cointQVgw2EwnJx3EFVPvD65gSsD9nJ7" },
  { address: "1GXA41EhA6sCBsDqbSLK5SLmZL6ohUPi2c", name: "CoinJar", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1GXA41EhA6sCBsDqbSLK5SLmZL6ohUPi2c" },
  { address: "1Q7TG4fhNp3c8DabSTudDv8UTaAtaNueHz", name: "CoinKite", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Q7TG4fhNp3c8DabSTudDv8UTaAtaNueHz" },
  { address: "15NGb2Nt9MqGRCekq1HSUFXrp3jKo7iSKb", name: "CoinMkt", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/15NGb2Nt9MqGRCekq1HSUFXrp3jKo7iSKb" },
  { address: "3ESRX5P14MRLktdbP16yBMQNRWvVayGkMh", name: "CoinPayments", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/3ESRX5P14MRLktdbP16yBMQNRWvVayGkMh" },
  { address: "3L442o8oyW3ho3kQ7xoZq6BezzsmNEApr2", name: "CoinPayments", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/3L442o8oyW3ho3kQ7xoZq6BezzsmNEApr2" },
  { address: "1AVr5bfxJhxDTSjg97aopr4gpU283mzUnR", name: "CoinURL", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1AVr5bfxJhxDTSjg97aopr4gpU283mzUnR" },
  { address: "1GefPt71woWCPXQZayBHwfuHswV91TESvH", name: "CoinVault", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1GefPt71woWCPXQZayBHwfuHswV91TESvH" },
  { address: "1Codxq4pdK72K6vDMQEhhmat2eVCcJ1XUX", name: "CoinWorker", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Codxq4pdK72K6vDMQEhhmat2eVCcJ1XUX" },
  { address: "1B9qiBowKqnojmJjejrXruu8jsfk9xXRC", name: "Comkort", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1B9qiBowKqnojmJjejrXruu8jsfk9xXRC" },
  { address: "1MXK3LHnqbjEKavuQLFCXGkNUeaLKy7oGX", name: "CrimeNet", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1MXK3LHnqbjEKavuQLFCXGkNUeaLKy7oGX" },
  { address: "33LJyHzNEv6wbftVKnNzbWDTp6CwZsmG4a", name: "CrimeNetwork", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/33LJyHzNEv6wbftVKnNzbWDTp6CwZsmG4a" },
  { address: "3PFXcGE89a3fGKjXUisnat2TmWxNtTWSrV", name: "CrimeNetwork", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/3PFXcGE89a3fGKjXUisnat2TmWxNtTWSrV" },
  { address: "1HjyazUrFoXwPtdU5qHyndBJ8wwwFX3nag", name: "CrimeNetwork", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1HjyazUrFoXwPtdU5qHyndBJ8wwwFX3nag" },
  { address: "1BaTt89GGSXzuzVoQFtGHUFZKme7YFSztd", name: "CrimeNetwork", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1BaTt89GGSXzuzVoQFtGHUFZKme7YFSztd" },
  { address: "1LPN9RkvTwm4LV4vK5Apz9qFDvKtqvuMiZ", name: "CrimeNetwork", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1LPN9RkvTwm4LV4vK5Apz9qFDvKtqvuMiZ" },
  { address: "1BaqXw9tWkcQvjqeQTzk7beUfF4NZURZtv", name: "CryptcoMiner", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1BaqXw9tWkcQvjqeQTzk7beUfF4NZURZtv" },
  { address: "1AWTbYC2jZUyLniAEqb9jegLogNp9QTosa", name: "Crypto-Trade", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1AWTbYC2jZUyLniAEqb9jegLogNp9QTosa" },
  { address: "1juicyo4Jpkm6L7cKiCgyqkr1o1uQ2Tib", name: "CryptoBounty", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1juicyo4Jpkm6L7cKiCgyqkr1o1uQ2Tib" },
  { address: "12P776pWtePmBcNopLXGHWzAw76ZiyfuCL", name: "CryptoLocker", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/12P776pWtePmBcNopLXGHWzAw76ZiyfuCL" },
  { address: "1JAURjs5obKhfhDVsUWHtcDpLufC6JXckf", name: "Cryptomine", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1JAURjs5obKhfhDVsUWHtcDpLufC6JXckf" },
  { address: "1BNGVtaD8fAAd7hv6eWFZsNdsCRonohqyA", name: "Cryptomine", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1BNGVtaD8fAAd7hv6eWFZsNdsCRonohqyA" },
  { address: "3QQLhY64kgsE6uumvuY1ueijLGin4TmMh4", name: "Cryptonator", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/3QQLhY64kgsE6uumvuY1ueijLGin4TmMh4" },
  { address: "15J8d7gz6Qa8Bmg6eMZjgtnevEAgzUzwBm", name: "Cryptonator", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/15J8d7gz6Qa8Bmg6eMZjgtnevEAgzUzwBm" },
  { address: "39GR2mespJVLv7Nit63RVg8dzRmF5PNpQg", name: "Cryptopay", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/39GR2mespJVLv7Nit63RVg8dzRmF5PNpQg" },
  { address: "1G8Gw2Ri7iNXK9huKT4xpVLwxu1ieg8Sc2", name: "Cryptopay", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1G8Gw2Ri7iNXK9huKT4xpVLwxu1ieg8Sc2" },
  { address: "16yxDnK926UcrAUtd4LfCDRzV8nhCQMKBY", name: "Cryptorush", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/16yxDnK926UcrAUtd4LfCDRzV8nhCQMKBY" },
  { address: "16xMFrPNyobst5bHFLxipY7zDfUibqKjkK", name: "CryptoStocks", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/16xMFrPNyobst5bHFLxipY7zDfUibqKjkK" },
  { address: "1PpaKoeMWSzULjnWFQd3u1DH684DCk8E7L", name: "DaDice", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1PpaKoeMWSzULjnWFQd3u1DH684DCk8E7L" },
  { address: "1eBTCe5wjBwdoxhM3r9xqk9bbvzpqrkJF", name: "Dagensia", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1eBTCe5wjBwdoxhM3r9xqk9bbvzpqrkJF" },
  { address: "1VayNert3x1KzbpzMGt2qdqrAThiRovi8", name: "DeepBit", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1VayNert3x1KzbpzMGt2qdqrAThiRovi8" },
  { address: "1NSRiSeDxqbjYWo59MGYvG4cBui5pESUvV", name: "Dgex", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1NSRiSeDxqbjYWo59MGYvG4cBui5pESUvV" },
  { address: "1KoHXyDr9wBcUB71W88ATzMEX9YgCTMFsn", name: "Dgex", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1KoHXyDr9wBcUB71W88ATzMEX9YgCTMFsn" },
  { address: "1729zYJYNp1GXsr2gUb6BLHhLkPkarGziT", name: "DiceBitco", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1729zYJYNp1GXsr2gUb6BLHhLkPkarGziT" },
  { address: "1GD2EiVa1rbbXcmFceyM47YN16fzVwn9j", name: "DiceOnCrack", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1GD2EiVa1rbbXcmFceyM47YN16fzVwn9j" },
  { address: "12264YHxBJqMPJYsnbkjcFpNKW9Ur2JNo7", name: "Dispenser.tf", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/12264YHxBJqMPJYsnbkjcFpNKW9Ur2JNo7" },
  { address: "1MfYPgT7NrhfKoTxi3gobmJ9u7Hvs4M2ac", name: "DoctorDMarket", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1MfYPgT7NrhfKoTxi3gobmJ9u7Hvs4M2ac" },
  { address: "1JtTHybwdQi4o61izdNPvg3myL8GidmbwM", name: "ePay", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1JtTHybwdQi4o61izdNPvg3myL8GidmbwM" },
  { address: "1GeQRaBMDAFTkp75UjHVD9eN3uLkBGoTgD", name: "Europex", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1GeQRaBMDAFTkp75UjHVD9eN3uLkBGoTgD" },
  { address: "1PoCt21VE2KHk9uRTRVV1NkPrrwnSFSAuJ", name: "FaucetBOX", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1PoCt21VE2KHk9uRTRVV1NkPrrwnSFSAuJ" },
  { address: "1E16DwuYa3osBRL6WbGoYFcPE4W5t9Y1b8", name: "Genesis-Mining", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1E16DwuYa3osBRL6WbGoYFcPE4W5t9Y1b8" },
  { address: "1E1tjUYpMXHrQWoEbPkwhsFPZgFXJXhSfJ", name: "GoCelery", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1E1tjUYpMXHrQWoEbPkwhsFPZgFXJXhSfJ" },
  { address: "3QTzR5VNRBJScnwdrXXRFNxnXgGUe3zZj5", name: "HaoBTC", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/3QTzR5VNRBJScnwdrXXRFNxnXgGUe3zZj5" },
  { address: "3CnzPpbn2saMxFtKXcebX6SS14fpCVYtLb", name: "HolyTransaction", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/3CnzPpbn2saMxFtKXcebX6SS14fpCVYtLb" },
  { address: "16TqNffTtXcNDM8skipD9NEv2wvN7oKX6y", name: "Ice-Dice", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/16TqNffTtXcNDM8skipD9NEv2wvN7oKX6y" },
  { address: "1BQPxuwZ9gvnmBxZMzsPvGaRAXUpvViGFk", name: "Inputs", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1BQPxuwZ9gvnmBxZMzsPvGaRAXUpvViGFk" },
  { address: "1PNGgjTAYALD7Ga4QV65U2j9EdJB1rFwD8", name: "Instawallet", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1PNGgjTAYALD7Ga4QV65U2j9EdJB1rFwD8" },
  { address: "19Tdda3bDwNvSMZWV9rL2x7CUp94BmQV6K", name: "Justcoin", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/19Tdda3bDwNvSMZWV9rL2x7CUp94BmQV6K" },
  { address: "145SmDToAhtfcBQhNxfeM8hnS6CBeiRukY", name: "Leancy", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/145SmDToAhtfcBQhNxfeM8hnS6CBeiRukY" },
  { address: "1p6ysKSRmraXfNpZ9LdR4tztVVoLy5osq", name: "Loanbase", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1p6ysKSRmraXfNpZ9LdR4tztVVoLy5osq" },
  { address: "17hvbaPZYBHY88dXR8Qx7GK95AF2c9mhF9", name: "MasterXchange", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/17hvbaPZYBHY88dXR8Qx7GK95AF2c9mhF9" },
  { address: "1PqvqY9U6mpyGddDKfiAnWXwurvq7uhs9H", name: "McxNOW", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1PqvqY9U6mpyGddDKfiAnWXwurvq7uhs9H" },
  { address: "19A1ExtArVanvx9dXuHArcyvVsjuCafGcn", name: "MintPal", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/19A1ExtArVanvx9dXuHArcyvVsjuCafGcn" },
  { address: "38V2yeJmverjzqU5xQJrwENujseZUs6y2Y", name: "MoonBit.co", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/38V2yeJmverjzqU5xQJrwENujseZUs6y2Y" },
  { address: "1BgQvy8vXjcV8bSPbGwC65Zs1dubfzfr5U", name: "MPEx", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1BgQvy8vXjcV8bSPbGwC65Zs1dubfzfr5U" },
  { address: "1BZbqaSrrSnaQ7VUuGUEHqJPqWwtE4nNUK", name: "MPEx", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1BZbqaSrrSnaQ7VUuGUEHqJPqWwtE4nNUK" },
  { address: "1NvHQuuddkQgEpXTat6fiWhSyeEAzg4f5n", name: "MyBitcoin", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1NvHQuuddkQgEpXTat6fiWhSyeEAzg4f5n" },
  { address: "1BqobbJbiFgip9Cp4ZB9Zh8GBSLeaMXUh9", name: "OkLink", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1BqobbJbiFgip9Cp4ZB9Zh8GBSLeaMXUh9" },
  { address: "1BQ41qwps4v2hJQs9CTLvFs8ZKzf4JqH1B", name: "PandoraOpenMarket", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1BQ41qwps4v2hJQs9CTLvFs8ZKzf4JqH1B" },
  { address: "19me6EaQKVRaeRmLVpYVdGwDVgyVcZoaSk", name: "Paymium", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/19me6EaQKVRaeRmLVpYVdGwDVgyVcZoaSk" },
  { address: "138nTWrsamJPaVFJH25MJunmUc9FPBcpfo", name: "PinballCoin", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/138nTWrsamJPaVFJH25MJunmUc9FPBcpfo" },
  { address: "1KkVeDgBbGXTEGJJSyoirmq2Z8KK5yVEzh", name: "Playt", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1KkVeDgBbGXTEGJJSyoirmq2Z8KK5yVEzh" },
  { address: "1K7LCXScZXwJYQfrFNDpd7crMVWRbNi8rA", name: "PocketRocketsCasino", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1K7LCXScZXwJYQfrFNDpd7crMVWRbNi8rA" },
  { address: "134V5Dj1ftzsGX61GpM3r2XVsPYZFRbMh9", name: "Polmine.pl", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/134V5Dj1ftzsGX61GpM3r2XVsPYZFRbMh9" },
  { address: "13HrfEaMkQjCSh7BT6XXzVpCNDS2Y4q9pN", name: "PonziCoin", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/13HrfEaMkQjCSh7BT6XXzVpCNDS2Y4q9pN" },
  { address: "1GtFNukD3h6h8ufw37cdqbivHRf4VRyhtj", name: "Purse", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1GtFNukD3h6h8ufw37cdqbivHRf4VRyhtj" },
  { address: "14gHieB8Tb6CKtmgaxZZBhd13H8nkykikb", name: "SealsWithClubs", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/14gHieB8Tb6CKtmgaxZZBhd13H8nkykikb" },
  { address: "14pPdjCEPBEivhKG84jbBr6exBRygCQm2p", name: "SecureVPN", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/14pPdjCEPBEivhKG84jbBr6exBRygCQm2p" },
  { address: "1NoqU1hKXxz8tzHeyacDZNsLRk8osW6Cfn", name: "SecureVPN", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1NoqU1hKXxz8tzHeyacDZNsLRk8osW6Cfn" },
  { address: "1FJmU2kNpAYXtiKgDyfNcejU7YPBMuDCWL", name: "SmenarnaBitcoin.cz", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1FJmU2kNpAYXtiKgDyfNcejU7YPBMuDCWL" },
  { address: "19vfz2AJj4kSkvC9t2mLg5sgtkLTk7Kwwu", name: "StrongCoin", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/19vfz2AJj4kSkvC9t2mLg5sgtkLTk7Kwwu" },
  { address: "1474DAcEAmX7E3XJpyhzLcWWZMa9s6XZnr", name: "UpDown.BT", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1474DAcEAmX7E3XJpyhzLcWWZMa9s6XZnr" },
  { address: "1Jve2pZLhddT1bpkq5wtFJWM6RknrRyDqF", name: "VaultOfSatoshi", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Jve2pZLhddT1bpkq5wtFJWM6RknrRyDqF" },
  { address: "17CGpNBEGhduMvEtvmGWQF647wSA1xNkye", name: "Vic-Socks", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/17CGpNBEGhduMvEtvmGWQF647wSA1xNkye" },
  { address: "15hMSiYVaH1bpZ1zRXgEoRnEEYvzju3Veo", name: "VIP72", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/15hMSiYVaH1bpZ1zRXgEoRnEEYvzju3Veo" },
  { address: "1LNrZ9JGpCqiBKz2bJRMX39k8Dk7hvs6YM", name: "WatchMyBit", category: "payment-service", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1LNrZ9JGpCqiBKz2bJRMX39k8Dk7hvs6YM" },

  // ── P2P Exchanges ───────────────────────────────────────────────
  { address: "1CYhbeZNHsqTxmpgug7pK2E2G98ziQUeju", name: "LocalBitcoins", category: "p2p-exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1CYhbeZNHsqTxmpgug7pK2E2G98ziQUeju" },
  { address: "1MoBpijEWMbXhKQkyr5FemGEmnyowvAvYG", name: "LocalBitcoins", category: "p2p-exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1MoBpijEWMbXhKQkyr5FemGEmnyowvAvYG" },
  { address: "1NZRtAdUkD15k2u26y9fkFZNPhG3FBoLrj", name: "Paxful", category: "p2p-exchange", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1NZRtAdUkD15k2u26y9fkFZNPhG3FBoLrj" },

  // ── Gambling ────────────────────────────────────────────────────
  { address: "18WsHUKZ3D6DPTjWcDGS99E1uL2xYaxDaW", name: "777Coin", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/18WsHUKZ3D6DPTjWcDGS99E1uL2xYaxDaW" },
  { address: "1NGSrBs4BAazQRfD3PafjHB9jwJocoNy6i", name: "999Dice", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1NGSrBs4BAazQRfD3PafjHB9jwJocoNy6i" },
  { address: "15tRxqGyKzmyzobfzSsxZfDmNyS8CZzBjr", name: "AnoniBet", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/15tRxqGyKzmyzobfzSsxZfDmNyS8CZzBjr" },
  { address: "1A9FVK5ZyXeo2LbweazbpYsd62a2CrvPHX", name: "Betcoin.ag", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1A9FVK5ZyXeo2LbweazbpYsd62a2CrvPHX" },
  { address: "19tXb4GqTdfeoeXFJXEyKZPVEmL5ZGn2ZF", name: "Betcoin.ag", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/19tXb4GqTdfeoeXFJXEyKZPVEmL5ZGn2ZF" },
  { address: "16kcGmLcJGPGY7FXkRF2VGU9Ei58WzAjqn", name: "Betcoin.tm", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/16kcGmLcJGPGY7FXkRF2VGU9Ei58WzAjqn" },
  { address: "1A2F5TxEGRmJW9WXSi7fKQWPrguQPdWgBX", name: "BetMoose", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1A2F5TxEGRmJW9WXSi7fKQWPrguQPdWgBX" },
  { address: "1ELgRHHUS5nzBCBLZXHwZCjTVko6g5jTTf", name: "BitcoinPokerTables", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1ELgRHHUS5nzBCBLZXHwZCjTVko6g5jTTf" },
  { address: "13e5iVURsR9NnkTCxco9nC2jgN2n6mmaVZ", name: "BitcoinVideoCasino", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/13e5iVURsR9NnkTCxco9nC2jgN2n6mmaVZ" },
  { address: "1Lmnst93apNjzDijcgNq98U9VMxV8a4vDX", name: "BitcoinVideoCasino", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Lmnst93apNjzDijcgNq98U9VMxV8a4vDX" },
  { address: "1Ltv6pjkGGBZZprYDqJ5AUieKuxBKPp2gx", name: "BitStarz", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Ltv6pjkGGBZZprYDqJ5AUieKuxBKPp2gx" },
  { address: "1bonesrnVHLNMW8aXB7hVrTUcLDgS9aZv", name: "BitZillions", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1bonesrnVHLNMW8aXB7hVrTUcLDgS9aZv" },
  { address: "1G1NwZrAiHiPdv1t2epwUNdFy9RzpbJzeQ", name: "BitZino", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1G1NwZrAiHiPdv1t2epwUNdFy9RzpbJzeQ" },
  { address: "1HRZDfV5wryukGtu9UBRP99kz2UURYLZju", name: "BTCOracle", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1HRZDfV5wryukGtu9UBRP99kz2UURYLZju" },
  { address: "161gTqw3CHVqiBfmC3vCLrXPob6wLQSKP4", name: "chatbot", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/161gTqw3CHVqiBfmC3vCLrXPob6wLQSKP4" },
  { address: "1LidBFX6XbVAMV64MJBZBL98NuFmJH3qYW", name: "CloudBet", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1LidBFX6XbVAMV64MJBZBL98NuFmJH3qYW" },
  { address: "1Cjhr5529GTyCLWJv8QMDVcAHz7hFHJVEr", name: "CoinGaming", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Cjhr5529GTyCLWJv8QMDVcAHz7hFHJVEr" },
  { address: "1cZFWGvZKngtKe7Dzo1M13yQ6HH9JaWmr", name: "Coinichiwa", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1cZFWGvZKngtKe7Dzo1M13yQ6HH9JaWmr" },
  { address: "152sH9J6umAA7JQrC9bGJ4MmK4q4Xehjbe", name: "Coinroll", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/152sH9J6umAA7JQrC9bGJ4MmK4q4Xehjbe" },
  { address: "1P56rjZgkxZVtKidXxXGpgMve92PkFop6k", name: "CoinRoyale", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1P56rjZgkxZVtKidXxXGpgMve92PkFop6k" },
  { address: "1QK7B4dVPvbFvH4cmmHb7jTd4rTaqWND12", name: "CoinRoyale", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1QK7B4dVPvbFvH4cmmHb7jTd4rTaqWND12" },
  { address: "1N87gVYcdZdpBPA4Sie2vUEjgXfkS56HoH", name: "Crypto-Games", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1N87gVYcdZdpBPA4Sie2vUEjgXfkS56HoH" },
  { address: "12wuUs4zNbdDGfkPKTmJqWeW1hkza3FHe9", name: "DiceCoin", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/12wuUs4zNbdDGfkPKTmJqWeW1hkza3FHe9" },
  { address: "1NdMRdVRQ23G1LehgU1bb4SVTeUV7SbLPX", name: "DiceNow", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1NdMRdVRQ23G1LehgU1bb4SVTeUV7SbLPX" },
  { address: "1KhiKyKTiMy7K81NQ5QtXbQ4i6iMmorUGc", name: "EveryDice", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1KhiKyKTiMy7K81NQ5QtXbQ4i6iMmorUGc" },
  { address: "16fDDgUhbBzjTEMWeLwUWAPgjmrrY5X3iU", name: "FairProof", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/16fDDgUhbBzjTEMWeLwUWAPgjmrrY5X3iU" },
  { address: "1HzWTtSCgteJySmzAD9A6WCiUsWWLNXAoL", name: "FortuneJack", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1HzWTtSCgteJySmzAD9A6WCiUsWWLNXAoL" },
  { address: "19DnYgF2sCFL3MXPNBbKuTHf9so2U9Noo3", name: "JetWin", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/19DnYgF2sCFL3MXPNBbKuTHf9so2U9Noo3" },
  { address: "19XRwLVFpcHyZXNF3PRKaMqHYQ7aiGCRA1", name: "JetWin", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/19XRwLVFpcHyZXNF3PRKaMqHYQ7aiGCRA1" },
  { address: "1P1kpj1vAcKUkQeG7nBbyMw88rT2ahzLRv", name: "Just-Dice", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1P1kpj1vAcKUkQeG7nBbyMw88rT2ahzLRv" },
  { address: "14o7zMMUJkG6De24r3JkJ6USgChq7iWF86", name: "Just-Dice", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/14o7zMMUJkG6De24r3JkJ6USgChq7iWF86" },
  { address: "1LuckyR1fFHEsXYyx5QK4UFzv3PEAepPMK", name: "Lucky Gaming (gambling)", category: "gambling", sourceNote: "Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)" },
  { address: "1NxaBCFQwejSZbQfWcYNwgqML5wWoE3rK4", name: "LuckyB.it", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1NxaBCFQwejSZbQfWcYNwgqML5wWoE3rK4" },
  { address: "1KHzYifcfbqPrqqExJRdco47kwYsmUSdCB", name: "MineField.BitcoinLab", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1KHzYifcfbqPrqqExJRdco47kwYsmUSdCB" },
  { address: "1FcBjuLrC2GbgUa98c5yqRF8iD8mFriT4f", name: "NitrogenSports", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1FcBjuLrC2GbgUa98c5yqRF8iD8mFriT4f" },
  { address: "14ChPPM8rPYJeHnw6kMVUDnNNKx1KnjYW4", name: "original", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/14ChPPM8rPYJeHnw6kMVUDnNNKx1KnjYW4" },
  { address: "1K3rhTs1NrpLqHaKGGXowdrg5z8tw78h5w", name: "Peerbet", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1K3rhTs1NrpLqHaKGGXowdrg5z8tw78h5w" },
  { address: "1NgTiJirEVpHH95xu5vktfpj23Xhv2bVc9", name: "PocketDice", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1NgTiJirEVpHH95xu5vktfpj23Xhv2bVc9" },
  { address: "1562k2H4iHqwqn3DEkjJk4qpnckWLffHpZ", name: "PrimeDice", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1562k2H4iHqwqn3DEkjJk4qpnckWLffHpZ" },
  { address: "12k6p3dfCLTRHPg55GLGPrh9kL5vGynMDP", name: "PrimeDice", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/12k6p3dfCLTRHPg55GLGPrh9kL5vGynMDP" },
  { address: "1HUZUdfNuHBNp7SCe2BytyqxbVdjuK3Hpx", name: "Rollin", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1HUZUdfNuHBNp7SCe2BytyqxbVdjuK3Hpx" },
  { address: "1Dp3STihediN4RtAD3ceuMJrMubhuTYroz", name: "SafeDice", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Dp3STihediN4RtAD3ceuMJrMubhuTYroz" },
  { address: "1CP1H61LnAbbxYgzhXD5SgrcJiswF3hYsi", name: "Satoshi-Karoshi", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1CP1H61LnAbbxYgzhXD5SgrcJiswF3hYsi" },
  { address: "14dFTvH5i3HvutH7GiGAdtEiWono5aqMa4", name: "Satoshi-Karoshi", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/14dFTvH5i3HvutH7GiGAdtEiWono5aqMa4" },
  { address: "16NREJWnWPci17qE7iohLayHY5JJJdB14s", name: "SatoshiBet", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/16NREJWnWPci17qE7iohLayHY5JJJdB14s" },
  { address: "1A1htgsVripuaDGCrHXztVTqTstGBskvq8", name: "SatoshiCircle", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1A1htgsVripuaDGCrHXztVTqTstGBskvq8" },
  { address: "16ZtFbC6dMcHtM8ebYkiZ1yhx9yoWrg1mq", name: "SatoshiDice", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/16ZtFbC6dMcHtM8ebYkiZ1yhx9yoWrg1mq" },
  { address: "18hxV615rCFfZzRKpgqAvkjRYMQ3ZZAx2b", name: "SatoshiMines", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/18hxV615rCFfZzRKpgqAvkjRYMQ3ZZAx2b" },
  { address: "1Gpg4Asj9NYCMkSVuYKJCabm9ybKN4GiUp", name: "SatoshiRoulette", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Gpg4Asj9NYCMkSVuYKJCabm9ybKN4GiUp" },
  { address: "1MRkLMumN9CVVmEGpbbJUXxuFAUsBBMKgs", name: "SecondsTrade", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1MRkLMumN9CVVmEGpbbJUXxuFAUsBBMKgs" },
  { address: "1GNiQzZs3JzzPet4yNEevHCCyFjN4YCX8D", name: "SuzukiDice", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1GNiQzZs3JzzPet4yNEevHCCyFjN4YCX8D" },
  { address: "1AhpCo63MF5ayyK7H3E98zoPhMYMVj8sH1", name: "SwCPoker", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1AhpCo63MF5ayyK7H3E98zoPhMYMVj8sH1" },
  { address: "1KGCdjvfoJLSmJ5m2dmh5ZbivgRwaqVinM", name: "YABTCL", category: "gambling", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1KGCdjvfoJLSmJ5m2dmh5ZbivgRwaqVinM" },

  // ── Mining Pools ────────────────────────────────────────────────
  { address: "1KM7w12SkjzJ1FYV2g1UCMzHjv3pkMgkEb", name: "AntPool", category: "mining-pool", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1KM7w12SkjzJ1FYV2g1UCMzHjv3pkMgkEb" },
  { address: "1GuMujABuc8kvzDTyVJFpcf4vszPUgsjiU", name: "AntPool", category: "mining-pool", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1GuMujABuc8kvzDTyVJFpcf4vszPUgsjiU" },
  { address: "1q3rvasrQpJ1wP9kUpKozP2hM7wUbzvpn", name: "Bitfury", category: "mining-pool", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1q3rvasrQpJ1wP9kUpKozP2hM7wUbzvpn" },
  { address: "1LQNQhwk5WSSQ3uFfzkywXitrVXn1myNC4", name: "BitMinter", category: "mining-pool", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1LQNQhwk5WSSQ3uFfzkywXitrVXn1myNC4" },
  { address: "1BTC1NNjeiAmFqe2n1QJjkEa4aMyAhkpKG", name: "BTC.com Pool", category: "mining-pool", sourceNote: "Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)" },
  { address: "1AvJbFTUMipcdp6DY4uJQTdpwzWdmSyRB8", name: "BTCCPool", category: "mining-pool", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1AvJbFTUMipcdp6DY4uJQTdpwzWdmSyRB8" },
  { address: "1Q7JG9GEn5L6EL8URrbsUomz3czbJrZSiC", name: "BW", category: "mining-pool", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Q7JG9GEn5L6EL8URrbsUomz3czbJrZSiC" },
  { address: "18M9o2mXNjNR96yKe7eyY6pfP6Nx4Nso3d", name: "EclipseMC", category: "mining-pool", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/18M9o2mXNjNR96yKe7eyY6pfP6Nx4Nso3d" },
  { address: "17mDji5CEomTtJs53uAac3TvAMACzd8tL1", name: "EclipseMC", category: "mining-pool", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/17mDji5CEomTtJs53uAac3TvAMACzd8tL1" },
  { address: "1EvAd2pu9YLitRFDF3isahG7fdbswngCzW", name: "Eligius.st", category: "mining-pool", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1EvAd2pu9YLitRFDF3isahG7fdbswngCzW" },
  { address: "1KFHE7w8BhaENAswwryaoccDb6qcT6DbYY", name: "F2Pool", category: "mining-pool", sourceNote: "Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)" },
  { address: "1HwcA2MrXwBLqiX8ZWKWVqQKdh3kSLfwbo", name: "GHash", category: "mining-pool", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1HwcA2MrXwBLqiX8ZWKWVqQKdh3kSLfwbo" },
  { address: "1N6LrEDiHuFwSyJYj2GedZM2FGk7kkLjn", name: "Kano.is", category: "mining-pool", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1N6LrEDiHuFwSyJYj2GedZM2FGk7kkLjn" },
  { address: "1PrLhiTAageHEAZea96437YQCtt2ENNwqh", name: "Kano.is", category: "mining-pool", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1PrLhiTAageHEAZea96437YQCtt2ENNwqh" },
  { address: "1LPGnMwacc8DBpCVNcohZ3Wr93MuYp1Lyb", name: "KnCMiner", category: "mining-pool", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1LPGnMwacc8DBpCVNcohZ3Wr93MuYp1Lyb" },
  { address: "1GbVUSW5WJmRCpaCJ4hanUny77oDaWW4to", name: "Luxor Mining", category: "mining-pool", sourceNote: "Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)" },
  { address: "3Eppdmq9SrPjT5dCD7z2Guv2oPKLSYoMUM", name: "SlushPool", category: "mining-pool", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/3Eppdmq9SrPjT5dCD7z2Guv2oPKLSYoMUM" },
  { address: "1EWserziorhx2vweWKQ8vogHSaQyVkUh41", name: "SlushPool", category: "mining-pool", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1EWserziorhx2vweWKQ8vogHSaQyVkUh41" },
  { address: "1Hz96kJKF2HLPGY15JWLB5m9qGNxvt8tHJ", name: "SlushPool (Braiins)", category: "mining-pool", sourceNote: "Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)" },
  { address: "1Pv1djEWrEvfgHkr8A27nkpLigmFYttCM3", name: "Telco214", category: "mining-pool", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1Pv1djEWrEvfgHkr8A27nkpLigmFYttCM3" },

  // ── Mixers / CoinJoin Services ──────────────────────────────────
  { address: "3Hd4H9djrv9vyQ9S2T86oVK42Fv3NUs4cM", name: "BitcoinFog", category: "mixer", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/3Hd4H9djrv9vyQ9S2T86oVK42Fv3NUs4cM" },
  { address: "1DLKdw2MgL6biQnevCKVTU3otYJNyN8NN5", name: "BitLaunder", category: "mixer", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1DLKdw2MgL6biQnevCKVTU3otYJNyN8NN5" },
  { address: "3NDzzVxiLBUs1WPvVGRfCYDTAD2Ua2PvW4", name: "Blender.io (mixer, OFAC-sanctioned)", category: "mixer", sourceNote: "OFAC SDN designation 2022-05-06 — https://home.treasury.gov/policy-issues/financial-sanctions/recent-actions/20220506" },
  { address: "32fbAZMTaQxNd2fAue1PgsiPgWfcsHBQQt", name: "Blender.io (mixer, OFAC-sanctioned)", category: "mixer", sourceNote: "OFAC SDN designation 2022-05-06 — https://home.treasury.gov/policy-issues/financial-sanctions/recent-actions/20220506" },
  { address: "3GMfGEDYMTq9G8dEHet1zLtUFJwYwSNa3Y", name: "Blender.io (mixer, OFAC-sanctioned)", category: "mixer", sourceNote: "OFAC SDN designation 2022-05-06 — https://home.treasury.gov/policy-issues/financial-sanctions/recent-actions/20220506" },
  { address: "39AALn7eTjdPzLb99hHhD6F7J8QWB3R2Rd", name: "Blender.io (mixer, OFAC-sanctioned)", category: "mixer", sourceNote: "OFAC SDN designation 2022-05-06 — https://home.treasury.gov/policy-issues/financial-sanctions/recent-actions/20220506" },
  { address: "3N3YSDvp4cbhEgNGabQxTN39kEzJmwG8Ah", name: "Blender.io (mixer, OFAC-sanctioned)", category: "mixer", sourceNote: "OFAC SDN designation 2022-05-06 — https://home.treasury.gov/policy-issues/financial-sanctions/recent-actions/20220506" },
  { address: "37g6WgqedzZx6nx51tYgssNG8Hnknyj5nL", name: "Blender.io (mixer, OFAC-sanctioned)", category: "mixer", sourceNote: "OFAC SDN designation 2022-05-06 — https://home.treasury.gov/policy-issues/financial-sanctions/recent-actions/20220506" },
  { address: "189sx3cvfJjJ13qKcEu1BZpV23Nz3pe5Gh", name: "HelixMixer", category: "mixer", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/189sx3cvfJjJ13qKcEu1BZpV23Nz3pe5Gh" },
  { address: "1FCGY1Y8gGGLGJQt25EV4NZwCp1o9471tm", name: "HelixMixer", category: "mixer", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1FCGY1Y8gGGLGJQt25EV4NZwCp1o9471tm" },
  { address: "bc1qq7p0es3dv5hcynjjf40f2xjjr6qp5py47d2f6n847vduuq9gvnyq7y9ecd", name: "Sinbad.io (mixer, OFAC-sanctioned)", category: "mixer", sourceNote: "OFAC SDN designation 2023-11-29 — https://ofac.treasury.gov/recent-actions/20231129" },
  { address: "1JHdQHkBZiim1cb4hyUh2PbzEbbg6z2TrF", name: "Sinbad.io (mixer, OFAC-sanctioned)", category: "mixer", sourceNote: "OFAC SDN designation 2023-11-29 — https://ofac.treasury.gov/recent-actions/20231129" },
  { address: "bc1qa5wkgaew2dkv56kfvj49j0av5nml45x9ek9hz6", name: "Wasabi Zksnacks Coordinator", category: "mixer", sourceNote: "Widely published / tagged on public blockchain explorers (e.g., blockchain.com, OXT, BitInfoCharts)" },

  // ── Darknet Markets (publicly documented / sanctioned) ──────────
  { address: "1ECiZTrN8TLcbcS8NRM8JJaRTvbYqvpRVQ", name: "AbraxasMarket", category: "darknet", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1ECiZTrN8TLcbcS8NRM8JJaRTvbYqvpRVQ" },
  { address: "15eqQ718wxdZubN6dBhJFLZwPaMaffrB5N", name: "AgoraMarket", category: "darknet", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/15eqQ718wxdZubN6dBhJFLZwPaMaffrB5N" },
  { address: "13xq4uaSh9RSXofnBudVBSfx1Fmo6YqS1W", name: "AlphaBayMarket", category: "darknet", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/13xq4uaSh9RSXofnBudVBSfx1Fmo6YqS1W" },
  { address: "1M6AsDG1XEKHkbDxkfBhFndKASNiVQGWnU", name: "AlphaBayMarket", category: "darknet", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1M6AsDG1XEKHkbDxkfBhFndKASNiVQGWnU" },
  { address: "1NVwBHFavtnpETyRAJohXJkfZED2sXzgoG", name: "BabylonMarket", category: "darknet", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1NVwBHFavtnpETyRAJohXJkfZED2sXzgoG" },
  { address: "15CcnXEmFSxF7ekkSJwGgxXj4PabA6tzdp", name: "BlackBankMarket", category: "darknet", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/15CcnXEmFSxF7ekkSJwGgxXj4PabA6tzdp" },
  { address: "18asyPgcKVqDUEpvcFtGUu6bYq7sGpRM95", name: "BlueSkyMarketplace", category: "darknet", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/18asyPgcKVqDUEpvcFtGUu6bYq7sGpRM95" },
  { address: "1KjRtR8Aoc8u7G2nVuM73pCtzYZP9kPHqs", name: "CannabisRoadMarket", category: "darknet", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1KjRtR8Aoc8u7G2nVuM73pCtzYZP9kPHqs" },
  { address: "1NULJaunUGqFFmnDtPRQ2oofnhLE1Hryye", name: "EvolutionMarket", category: "darknet", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1NULJaunUGqFFmnDtPRQ2oofnhLE1Hryye" },
  { address: "16qEA5ubDpuopgnX4DsQDeeiB7vLn6sqKE", name: "GermanPlazaMarket", category: "darknet", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/16qEA5ubDpuopgnX4DsQDeeiB7vLn6sqKE" },
  { address: "1DkPms5kEGMzXKVcR2bCpYkQHiF9bAAQLF", name: "GreenRoadMarket", category: "darknet", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1DkPms5kEGMzXKVcR2bCpYkQHiF9bAAQLF" },
  { address: "1BCWMwpR4M1nYUuuYe2bmzrNuwGoF9ZAbA", name: "Hydra Market (darknet, OFAC-sanctioned)", category: "darknet", sourceNote: "OFAC SDN designation 2022-04-05 — https://home.treasury.gov/policy-issues/financial-sanctions/recent-actions/20220405" },
  { address: "1MQBDeRWsiJBf7K1VGjJ7PWEL6GJXMfmLg", name: "Hydra Market (darknet, OFAC-sanctioned)", category: "darknet", sourceNote: "OFAC SDN designation 2022-04-05 — https://home.treasury.gov/policy-issues/financial-sanctions/recent-actions/20220405" },
  { address: "bc1qj6j6p0jdefl6pvdzx3kx8245yy5mz6q4luhzes", name: "Hydra Market (darknet, OFAC-sanctioned)", category: "darknet", sourceNote: "OFAC SDN designation 2022-04-05 — https://home.treasury.gov/policy-issues/financial-sanctions/recent-actions/20220405" },
  { address: "1D1ej7zQzywWBDNXKNYpmH7Hso2U9koDG4", name: "Hydra Market (darknet, OFAC-sanctioned)", category: "darknet", sourceNote: "OFAC SDN designation 2022-04-05 — https://home.treasury.gov/policy-issues/financial-sanctions/recent-actions/20220405" },
  { address: "1A3iYY4c3dkgNYGewzYzr7EsqfBuWXibGo", name: "Hydra Market (darknet, OFAC-sanctioned)", category: "darknet", sourceNote: "OFAC SDN designation 2022-04-05 — https://home.treasury.gov/policy-issues/financial-sanctions/recent-actions/20220405" },
  { address: "1K2fmE9hfhbRNSZoBvCBWZAvsS5idTUxBG", name: "Hydra Market (darknet, OFAC-sanctioned)", category: "darknet", sourceNote: "OFAC SDN designation 2022-04-05 — https://home.treasury.gov/policy-issues/financial-sanctions/recent-actions/20220405" },
  { address: "1GYuu9d5HPikafbys3k5Q3DRJq6debGsoB", name: "Hydra Market (darknet, OFAC-sanctioned)", category: "darknet", sourceNote: "OFAC SDN designation 2022-04-05 — https://home.treasury.gov/policy-issues/financial-sanctions/recent-actions/20220405" },
  { address: "3KvBX3jo69Qn8jHy44M33RYoeYcf8DdRBD", name: "Hydra Market (darknet, OFAC-sanctioned)", category: "darknet", sourceNote: "OFAC SDN designation 2022-04-05 — https://home.treasury.gov/policy-issues/financial-sanctions/recent-actions/20220405" },
  { address: "1A1ZkfWXjv9ubTMmNWnMEye9sdx1XL6URa", name: "MiddleEarthMarketplace", category: "darknet", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1A1ZkfWXjv9ubTMmNWnMEye9sdx1XL6URa" },
  { address: "14gT7hoSBzcWxit8SW6n9SCMHdzMEq2xsq", name: "NucleusMarket", category: "darknet", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/14gT7hoSBzcWxit8SW6n9SCMHdzMEq2xsq" },
  { address: "13BWo7vKx9vEnhJfEffA5XNqu2XDJM654c", name: "SheepMarketplace", category: "darknet", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/13BWo7vKx9vEnhJfEffA5XNqu2XDJM654c" },
  { address: "12X1JCchgnyRvbFPbnaUYkKz8dmr9yKSak", name: "SilkRoad2Market", category: "darknet", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/12X1JCchgnyRvbFPbnaUYkKz8dmr9yKSak" },
  { address: "1znk3BFpFQembmPfNgUvv6wTghKbYyLHt", name: "SilkRoadMarketplace", category: "darknet", sourceNote: "WalletExplorer.com service clustering — https://www.walletexplorer.com/address/1znk3BFpFQembmPfNgUvv6wTghKbYyLHt" },

  // ── Scams, Ponzi, Ransomware & Sanctioned (public evidence) ─────
  { address: "1BtcBoSSnqe8mFJCUEyCNmo3EcF8Yzhpnc", name: "10percentbtc (Ponzi scheme)", category: "scam", sourceNote: "Academic Ponzi-scheme dataset — https://arxiv.org/abs/1803.00646" },
  { address: "1E5MCTtXn7n2svpZ1bDHZXndY9K7qQeqZP", name: "120cycle (Ponzi scheme)", category: "scam", sourceNote: "Academic Ponzi-scheme dataset — https://arxiv.org/abs/1803.00646" },
  { address: "1Lud76Q98VRHCUiyK7XUs7AgFofrqXeP78", name: "7ev3n (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "377CY1m8W2qbQQX5HHjziimdh2faGjDeLv", name: "Apt (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "1AQp51H22WHDzLgK64NoUo3Bg3T183QR22", name: "btc-doubler (Ponzi scheme)", category: "scam", sourceNote: "Academic Ponzi-scheme dataset — https://arxiv.org/abs/1803.00646" },
  { address: "1PayoutRrC8wxxZ9ygmeaRj3qTPug8tDYu", name: "btcgains (Ponzi scheme)", category: "scam", sourceNote: "Academic Ponzi-scheme dataset — https://arxiv.org/abs/1803.00646" },
  { address: "1MfVk1utxgvGjMFV3K3CzXsDRDZznj5tey", name: "Bucbi (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "1GaVKrVT17DN4dnWbTqGB9qG3rQrk1JBe9", name: "Chimera (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "1HssDyDTZj1hVdwhdpF49wLKLPQoCRJB9T", name: "Comradecircle (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "1KG8rWYWRYHfvjVe8ddEyJNCg6HxVWYSQm", name: "Cryptconsole (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "19a93M9JGX377yfVzWRBs4abcUpwLfXsvE", name: "Cryptohitman (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "18AVPLKGBamXtGpdT3kP2b5Dv3iBUDpjKv", name: "Cryptohost (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "1KP72fBmh3XBRfuJDMn53APaqM6iMRspCh", name: "Cryptolocker (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "1FyedPPk923wRfmVphV1CLt3bVLGxHZXpK", name: "cryptory (Ponzi scheme)", category: "scam", sourceNote: "Academic Ponzi-scheme dataset — https://arxiv.org/abs/1803.00646" },
  { address: "1KpP1YGGxPHKTLgET82JBngcsBuifp3noW", name: "Cryptotorlocker2015 (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "18e372GNwjGG5SYeHucuD1yLEWh7a6dWf1", name: "Cryptxxx (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "1A6GJMhpPhCcM557o62scEtuVXNAFe74fa", name: "Ctb-locker (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "1382JAg5xbQv7QNwq1svDeyw6ELtNCmujG", name: "Dmalocker (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "192awRvM4V8LS24GSHj6o3v2fVQ5QYh4pB", name: "Eda2 (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "14k81d3PhfB8A3GJAGa1wmbRdE7x7fgby8", name: "Exotic (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "1P29xxkwy6wvLxJVA2cLoXBri2hZzaweSV", name: "Flyper (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "1MBwkTssJkqRvXmAFcSEZ3xTD39A9rkyYA", name: "Globe (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "1GvgRRnLpUP7KsLZLE23ridD45MUxHoAJ4", name: "Globeimposter (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "1MzNQ7HV8dQ6XQ52zBGYkCZkkWv2Pd3VG6", name: "grandagofinance (Ponzi scheme)", category: "scam", sourceNote: "Academic Ponzi-scheme dataset — https://arxiv.org/abs/1803.00646" },
  { address: "1CpVAEg4BgVzjiHshgeZfitZLV1t1zo6Qg", name: "investorbitcoin (Ponzi scheme)", category: "scam", sourceNote: "Academic Ponzi-scheme dataset — https://arxiv.org/abs/1803.00646" },
  { address: "15fbyNgDnqYQR5vSHJ8PTAEJbKy4dwNBCZ", name: "Jigsaw (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "1LaxoTrQy51LnB289VmoSAgN6J6UrJbfL9", name: "laxotrade (Ponzi scheme)", category: "scam", sourceNote: "Academic Ponzi-scheme dataset — https://arxiv.org/abs/1803.00646" },
  { address: "134r8iHv69xdT6p5qVKTsHrcUEuBVZAYak", name: "Lazarus Group (DPRK, OFAC-sanctioned)", category: "scam", sourceNote: "OFAC / US Treasury — https://www.treasury.gov/resource-center/sanctions/OFAC-Enforcement/Pages/20200302.aspx" },
  { address: "15YK647qtoZQDzNrvY6HJL6QwXduLHfT28", name: "Lazarus Group (DPRK, OFAC-sanctioned)", category: "scam", sourceNote: "OFAC / US Treasury — https://www.treasury.gov/resource-center/sanctions/OFAC-Enforcement/Pages/20200302.aspx" },
  { address: "1PfwHNxUnkpfkK9MKjMqzR3Xq3KCtq9u17", name: "Lazarus Group (DPRK, OFAC-sanctioned)", category: "scam", sourceNote: "OFAC / US Treasury — https://www.treasury.gov/resource-center/sanctions/OFAC-Enforcement/Pages/20200302.aspx" },
  { address: "14kqryJUxM3a7aEi117KX9hoLUw592WsMR", name: "Lazarus Group (DPRK, OFAC-sanctioned)", category: "scam", sourceNote: "OFAC / US Treasury — https://www.treasury.gov/resource-center/sanctions/OFAC-Enforcement/Pages/20200302.aspx" },
  { address: "1F2Gdug9ib9NQMhKMGGJczzMk5SuENoqrp", name: "Lazarus Group (DPRK, OFAC-sanctioned)", category: "scam", sourceNote: "OFAC / US Treasury — https://www.treasury.gov/resource-center/sanctions/OFAC-Enforcement/Pages/20200302.aspx" },
  { address: "3F2sZ4jbhvDKQdGbHYPC6ZxFXEau2m5Lqj", name: "Lazarus Group (DPRK, OFAC-sanctioned)", category: "scam", sourceNote: "OFAC / US Treasury — https://www.treasury.gov/resource-center/sanctions/OFAC-Enforcement/Pages/20200302.aspx" },
  { address: "1AXUTu9y3H8w4wYx4BjyFWgRhZKDhmcMrn", name: "Lazarus Group (DPRK, OFAC-sanctioned)", category: "scam", sourceNote: "OFAC / US Treasury — https://www.treasury.gov/resource-center/sanctions/OFAC-Enforcement/Pages/20200302.aspx" },
  { address: "1Hn9ErTCPRP6j5UDBeuXPGuq5RtRjFJxJQ", name: "Lazarus Group (DPRK, OFAC-sanctioned)", category: "scam", sourceNote: "OFAC / US Treasury — https://www.treasury.gov/resource-center/sanctions/OFAC-Enforcement/Pages/20200302.aspx" },
  { address: "1123pJv8jzeFQaCV4w644pzQJzVWay2zcA", name: "Locky (Ransomware)", category: "scam", sourceNote: "Ransomware address dataset (Paquet-Clouston et al.) — https://zenodo.org/record/1238041" },
  { address: "1FuypAdeC7mSmYBsQLbG9XV261bnfgWbgB", name: "minimalism10 (Ponzi scheme)", category: "scam", sourceNote: "Academic Ponzi-scheme dataset — https://arxiv.org/abs/1803.00646" },
  { address: "1F8ZKpjMDpnpF79mZ1pxZRoNKZgXm4Tf1d", name: "miniponzicoin (Ponzi scheme)", category: "scam", sourceNote: "Academic Ponzi-scheme dataset — https://arxiv.org/abs/1803.00646" },
  { address: "1Ee9ZiZkmygAXUiyeYKRSA3tLe4vNYEAgA", name: "nanoindustryinv (Ponzi scheme)", category: "scam", sourceNote: "Academic Ponzi-scheme dataset — https://arxiv.org/abs/1803.00646" },
  { address: "1BmZW65ZoeLa1kbL9MPFLfkS818mqFUSma", name: "openponzi (Ponzi scheme)", category: "scam", sourceNote: "Academic Ponzi-scheme dataset — https://arxiv.org/abs/1803.00646" },
  { address: "3ETAVt2scYBFkBFksuNDk1i5tDLQ2c4zWR", name: "PlusToken Ponzi Scheme", category: "scam", sourceNote: "PlusToken ponzi documentation — https://boxmining.com/plus-token-ponzi/" },
  { address: "3EYsru4LUcN258sENYPu5Py3S5WnqxEcnE", name: "PlusToken Ponzi Scheme", category: "scam", sourceNote: "PlusToken ponzi documentation — https://boxmining.com/plus-token-ponzi/" },
  { address: "3HKs1g7u5a1uU4pC5HaNooYMbL1Lao4mv4", name: "PlusToken Ponzi Scheme", category: "scam", sourceNote: "PlusToken ponzi documentation — https://boxmining.com/plus-token-ponzi/" },
  { address: "3ESakThMrdVVrbhhcpf9spicyjCg1Uk8Jm", name: "PlusToken Ponzi Scheme", category: "scam", sourceNote: "PlusToken ponzi documentation — https://boxmining.com/plus-token-ponzi/" },
  { address: "33LNws16Wfs12usWBNfa1MSX3YKY6Hdayf", name: "PlusToken Ponzi Scheme", category: "scam", sourceNote: "PlusToken ponzi documentation — https://boxmining.com/plus-token-ponzi/" },
  { address: "1ponziUjuCVdB167ZmTWH48AURW1vE64q", name: "ponzi (Ponzi scheme)", category: "scam", sourceNote: "Academic Ponzi-scheme dataset — https://arxiv.org/abs/1803.00646" },
  { address: "1121DWBuPTD7SuTxx7BivG6hyVJbhA3McT", name: "Sextortion Spam Campaign", category: "scam", sourceNote: "Cisco Talos sextortion research — https://blog.talosintelligence.com/2018/10/anatomy-of-sextortion-scam.html" },
  { address: "1122hj47AmnW3sCWayqm1ZDubmcwenw2x1", name: "Sextortion Spam Campaign", category: "scam", sourceNote: "Cisco Talos sextortion research — https://blog.talosintelligence.com/2018/10/anatomy-of-sextortion-scam.html" },
  { address: "1123AexJeYCh2wdaTLEAnuEoDTYGNYzdfZ", name: "Sextortion Spam Campaign", category: "scam", sourceNote: "Cisco Talos sextortion research — https://blog.talosintelligence.com/2018/10/anatomy-of-sextortion-scam.html" },
  { address: "11242JEH6eaj4rhueWp5SupdaFPUH6nUNz", name: "Sextortion Spam Campaign", category: "scam", sourceNote: "Cisco Talos sextortion research — https://blog.talosintelligence.com/2018/10/anatomy-of-sextortion-scam.html" },
  { address: "1124MAxkpiKfaP6gJATe9rDnfvkXSuhiGc", name: "Sextortion Spam Campaign", category: "scam", sourceNote: "Cisco Talos sextortion research — https://blog.talosintelligence.com/2018/10/anatomy-of-sextortion-scam.html" },
  { address: "11266pJrAZJowmDMUieqnJbBM4SNkkBamH", name: "Sextortion Spam Campaign", category: "scam", sourceNote: "Cisco Talos sextortion research — https://blog.talosintelligence.com/2018/10/anatomy-of-sextortion-scam.html" },
  { address: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", name: "Twitter 2020 Hack Scam", category: "scam", sourceNote: "2020 Twitter hack — https://techcrunch.com/2020/07/15/twitter-accounts-hacked-crypto-scam/" },
  { address: "bc1qwr30ddc04zqp878c0evdrqfx564mmf0dy2w39l", name: "Twitter 2020 Hack Scam", category: "scam", sourceNote: "2020 Twitter hack — https://techcrunch.com/2020/07/15/twitter-accounts-hacked-crypto-scam/" },
  { address: "1Ai52Uw6usjhpcDrwSmkUvjuqLpcznUuyF", name: "Twitter 2020 Hack Scam", category: "scam", sourceNote: "2020 Twitter hack — https://techcrunch.com/2020/07/15/twitter-accounts-hacked-crypto-scam/" },
];
  
  /** Build a lookup map from a list of entries: address → EntityEntry */
  function buildEntityMap(entries: EntityEntry[]): Map<string, EntityEntry> {
    const map = new Map<string, EntityEntry>();
    for (const entry of entries) {
      map.set(entry.address, entry);
    }
    return map;
  }

  /** The bundled (default) lookup map. Never mutated — used as the fallback. */
  const _bundledMap = buildEntityMap(ENTITY_LIST);

  /**
   * The active lookup map. Defaults to the bundled list but can be replaced at
   * runtime by a user-supplied offline snapshot (see `data/entity-list-store.ts`).
   * Either way this is purely in-memory — zero network access.
   */
  let _activeMap: Map<string, EntityEntry> = _bundledMap;
  let _activeSource: 'bundled' | 'imported' = 'bundled';

  /**
   * Look up an address against the active entity list.
   * Returns the matching entry, or undefined if not found.
   * Purely in-memory — zero network access.
   */
  export function lookupEntity(address: string): EntityEntry | undefined {
    return _activeMap.get(address);
  }

  /**
   * Look up multiple addresses, returning only those with matches.
   */
  export function lookupEntities(addresses: string[]): Map<string, EntityEntry> {
    const result = new Map<string, EntityEntry>();
    for (const addr of addresses) {
      const entry = _activeMap.get(addr);
      if (entry) result.set(addr, entry);
    }
    return result;
  }

  /** Number of entries in the bundled (default) list. */
  export function getBundledEntityCount(): number {
    return _bundledMap.size;
  }

  /** Number of entries in the currently active list. */
  export function getActiveEntityCount(): number {
    return _activeMap.size;
  }

  /** Whether the active list is the bundled default or a user import. */
  export function getActiveEntitySource(): 'bundled' | 'imported' {
    return _activeSource;
  }

  /** Snapshot of the currently active entries (e.g. for export/editing). */
  export function getActiveEntityList(): EntityEntry[] {
    return Array.from(_activeMap.values());
  }

  /**
   * Replace the active list with a user-supplied snapshot. In-memory only;
   * persistence is handled by the caller (`data/entity-list-store.ts`).
   */
  export function setActiveEntityList(entries: EntityEntry[]): void {
    _activeMap = buildEntityMap(entries);
    _activeSource = 'imported';
  }

  /** Restore the active list back to the bundled default. */
  export function resetActiveEntityList(): void {
    _activeMap = _bundledMap;
    _activeSource = 'bundled';
  }

  export const ENTITY_CATEGORY_LABELS: Record<EntityCategory, string> = {
    exchange: 'Exchange',
    'payment-service': 'Payment Service',
    gambling: 'Gambling',
    scam: 'Scam / Fraud',
    darknet: 'Darknet Market',
    'mining-pool': 'Mining Pool',
    mixer: 'Mixer / CoinJoin Service',
    'p2p-exchange': 'P2P Exchange',
  };

  export const ENTITY_CATEGORY_TAG_NAMES: Record<EntityCategory, string> = {
    exchange: 'privacy:entity-exchange',
    'payment-service': 'privacy:entity-payment',
    gambling: 'privacy:entity-gambling',
    scam: 'privacy:entity-scam',
    darknet: 'privacy:entity-darknet',
    'mining-pool': 'privacy:entity-mining-pool',
    mixer: 'privacy:entity-mixer',
    'p2p-exchange': 'privacy:entity-p2p',
  };

  export const ENTITY_CATEGORY_COLORS: Record<EntityCategory, string> = {
    exchange: '#3b82f6',
    'payment-service': '#22c55e',
    gambling: '#f59e0b',
    scam: '#ef4444',
    darknet: '#7c3aed',
    'mining-pool': '#64748b',
    mixer: '#ec4899',
    'p2p-exchange': '#0ea5e9',
  };
  