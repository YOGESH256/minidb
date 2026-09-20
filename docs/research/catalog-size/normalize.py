"""Normalize public exports for byte measurement; never truncate fields or skip bad records.
Empty physical lines outside quoted CSV fields are ignored and counted in the manifest.

python3 docs/research/catalog-size/normalize.py /private/tmp /private/tmp/minidb-catalog-sizes
MARC uses an optimistic per-record schema: leader plus each complete field as a TEXT cell.
Its tags/order live in column names. A shared fixed schema would need additional NULL cells.
"""
import collections
import csv
import gzip
import hashlib
import json
from pathlib import Path
import re
import sys

csv.field_size_limit(10_000_000)
sources = json.loads(Path(__file__).with_name('sources.json').read_text())
data_dir, out_dir = map(Path, sys.argv[1:3])
out_dir.mkdir(parents=True, exist_ok=True)


def marc_rows(path):
    with path.open('rb') as stream:
        while prefix := stream.read(5):
            assert len(prefix) == 5 and prefix.isdigit(), 'invalid MARC record prefix'
            size = int(prefix)
            record = prefix + stream.read(size - 5)
            assert len(record) == size and record[-1:] == b'\x1d', 'truncated MARC record'
            leader = record[:24].decode('ascii')
            assert leader[9] == 'a', 'MARC-8 input requires conversion; never silently decode as UTF-8'
            base = int(leader[12:17])
            assert record[base - 1:base] == b'\x1e' and (base - 25) % 12 == 0
            cells, labels, tags = [leader], ['leader'], []
            payload_bytes, title_index = 0, None
            for entry in range(24, base - 1, 12):
                tag = record[entry:entry+3].decode('ascii')
                length = int(record[entry+3:entry+7])
                offset = int(record[entry+7:entry+12])
                raw = record[base+offset:base+offset+length]
                assert len(raw) == length and raw[-1:] == b'\x1e'
                value = raw[:-1].decode('utf-8', errors='strict')
                if tag == '245' and title_index is None:
                    title_index = len(cells)
                labels.append(f'f{tag}_{len(cells)}')
                cells.append(value)
                tags.append((tag, value))
                # Deliberately optimistic bound: omit leader, indicators, subfield codes and framing.
                bare = value if int(tag) < 10 else re.sub('\x1f.', '', value[2:])
                payload_bytes += len(bare.encode('utf-8'))
            def selected(tag_test, codes=None):
                values = []
                for tag, value in tags:
                    if not tag_test(tag):
                        continue
                    for subfield in value[2:].split('\x1f')[1:]:
                        if subfield and (codes is None or subfield[0] in codes):
                            values.append(subfield[1:])
                return '\n'.join(values) if values else None
            source_id = next((v for t, v in tags if t == '001'), None)
            yield {'source_id': source_id, 'cells': cells, 'columns': labels,
                   'title_index': title_index, 'payload_bytes': payload_bytes,
                   'projection': [selected(lambda t: t == '245', 'abnp'),
                                  selected(lambda t: t in ('260', '264'), 'b'),
                                  selected(lambda t: t.startswith('6'))]}


def csv_rows(path, source):
    tsv = source['format'] == 'tsv.gz'
    opener = gzip.open if tsv else open
    with opener(path, 'rt', encoding='utf-8-sig', newline='') as stream:
        reader = csv.reader(stream, delimiter='\t' if tsv else ',',
                            quoting=csv.QUOTE_NONE if tsv else csv.QUOTE_MINIMAL, strict=True)
        columns = next(reader)
        title_index = columns.index(source['title'])
        publisher_index = columns.index(source['publisher'])
        subject_indexes = [columns.index(c) for c in source['subjects']]
        for cells in reader:
            if not cells:
                source['blank_lines_ignored'] = source.get('blank_lines_ignored', 0) + 1
                continue
            assert len(cells) == len(columns), f'CSV width {len(cells)} != {len(columns)} at line {reader.line_num}'
            yield {'source_id': cells[0], 'cells': cells, 'title_index': title_index,
                   'payload_bytes': sum(len(c.encode('utf-8')) for c in cells),
                   'projection': [cells[title_index], cells[publisher_index],
                                  '\n'.join(cells[i] for i in subject_indexes) if subject_indexes else None]}


manifest = []
for source in sources:
    path = data_dir / source['file']
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    count, widths, missing_title = 0, collections.Counter(), 0
    rows = marc_rows(path) if source['format'] == 'marc' else csv_rows(path, source)
    target = out_dir / (source['id'] + '.jsonl')
    with target.open('w', encoding='utf-8') as output:
        for count, row in enumerate(rows, 1):
            row['id'] = count
            widths[len(row['cells'])] += 1
            missing_title += row['title_index'] is None
            output.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
    entry = {**source, 'sha256': digest, 'download_bytes': path.stat().st_size,
             'records': count, 'field_count_distribution': dict(widths), 'missing_title': missing_title}
    manifest.append(entry)
    print(json.dumps({k: entry[k] for k in ('id', 'records', 'download_bytes', 'missing_title')}), flush=True)
(out_dir / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
