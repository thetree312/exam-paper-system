const chunks=[];
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => console.log(JSON.stringify(chunks.join(''))));
