const fs = require('fs');
const path = require('path');

const saveNetworkData = (networkArray, dir) => {
    fs.writeFileSync(path.join(dir, 'datasetNetwork.json'), JSON.stringify({ data: networkArray }, null, 2));
};

const saveGraph = (graphArray, dir) => {
    // Outputs the Adjacency List / Node-Edge structures mapping DOM to Network
    fs.writeFileSync(path.join(dir, 'datasetGraph.json'), JSON.stringify({ pages: graphArray }, null, 2));
};

module.exports = { saveGraph, saveNetworkData };