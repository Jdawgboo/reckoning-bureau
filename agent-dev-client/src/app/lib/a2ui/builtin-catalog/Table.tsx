import React, { type FC, useState } from 'react';
import { useIntl } from 'react-intl';

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/app/lib/shadcdn/table';

import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/app/lib/shadcdn/pagination';

import { Card } from '@/app/lib/shadcdn/card';
import type { A2uiNodeViewProps } from '@/app/lib/a2ui/catalog.tsx';
import { optStr, str } from '@/app/lib/a2ui/props.ts';
import { isRecord } from '@/app/lib/util/type-guards.ts';
import { messages } from '@/app/lib/localization/messages.ts';

export type TableProps = {
  title?: string;
  description?: string;
  caption?: string;
  columns: {
    header: string;
    accessor: string;
  }[];
  rows: string[][];
  footer?: {
    content: string;
    colSpan?: number;
  }[];
};

const ITEMS_PER_PAGE = 20;

/** Cells at or under this length count as "compact" — a last column made of
 *  compact cells (prices, counts, short statuses) right-aligns, the classic
 *  metrics-on-the-right table convention. Prose columns never qualify. */
const COMPACT_CELL_MAX_CHARS = 16;

function isCompactColumn(rows: string[][], columnIndex: number): boolean {
  return rows.every((row) => (row[columnIndex] ?? '').length <= COMPACT_CELL_MAX_CHARS);
}

type Props = { argumentsProps: TableProps };

const TableComponent: FC<Props> = ({ argumentsProps }) => {
  const intl = useIntl();
  const { title, description, caption, columns = [], rows = [], footer = [] } = argumentsProps;

  const [currentPage, setCurrentPage] = useState<number>(1);

  const totalPages = Math.ceil(rows.length / ITEMS_PER_PAGE);

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

  const paginatedData = rows.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE,
  );

  if (!columns.length || !rows.length) {
    return null;
  }

  const lastIndex = columns.length - 1;
  const alignLastRight = columns.length > 1 && isCompactColumn(rows, lastIndex);
  const cellAlign = (colIndex: number) =>
    colIndex === lastIndex && alignLastRight ? 'text-right tabular-nums whitespace-nowrap' : '';

  return (
    <div>
      {title ? <h3 className="mb-1 text-base font-semibold text-foreground">{title}</h3> : null}
      {description ? <p className="mb-3 text-sm text-muted-foreground">{description}</p> : null}
      <Card className="flex w-full flex-col overflow-hidden rounded-md border border-border">
        <Table>
          {caption && <TableCaption className="px-5 pb-4">{caption}</TableCaption>}
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((column, index) => (
                <TableHead
                  className={`px-5 pb-3 pt-4 align-bottom text-xs font-medium uppercase tracking-wider text-muted-foreground ${cellAlign(index)}`}
                  key={index}
                >
                  {column.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedData.map((row, rowIndex) => (
              <TableRow key={rowIndex} className="border-border/60 hover:bg-muted/40">
                {columns.map((column, colIndex) => {
                  const cellData = row[colIndex];
                  const isUrl = typeof cellData === 'string' && cellData.startsWith('http');
                  const emphasis = colIndex === 0 ? 'font-medium' : '';

                  return (
                    <TableCell
                      className={`px-5 py-3.5 align-top leading-relaxed ${emphasis} ${cellAlign(colIndex)}`}
                      key={colIndex}
                    >
                      {isUrl ? (
                        <a
                          href={cellData}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary"
                        >
                          {intl.formatMessage(messages.link)}
                        </a>
                      ) : (
                        cellData
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
          {footer && footer.length > 0 && (
            <TableFooter>
              <TableRow>
                {footer.map((footerCell, index) => (
                  <TableCell
                    className="px-5 py-3 align-top"
                    key={index}
                    colSpan={footerCell.colSpan || 1}
                  >
                    {footerCell.content}
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          )}
        </Table>
        {totalPages > 1 && (
          <Pagination className="border-t border-border px-5 py-3">
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  href="#"
                  onClick={() => handlePageChange(Math.max(currentPage - 1, 1))}
                />
              </PaginationItem>
              {Array.from({ length: totalPages }).map((_, index) => (
                <PaginationItem key={index}>
                  <PaginationLink
                    href="#"
                    isActive={currentPage === index + 1}
                    onClick={() => handlePageChange(index + 1)}
                  >
                    {index + 1}
                  </PaginationLink>
                </PaginationItem>
              ))}
              <PaginationItem>
                <PaginationNext
                  href="#"
                  onClick={() => handlePageChange(Math.min(currentPage + 1, totalPages))}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        )}
      </Card>
    </div>
  );
};

function TableRoot(props: Props) {
  return <TableComponent {...props} />;
}

export default TableRoot;

function tableColumns(value: unknown): TableProps['columns'] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isRecord)
    .map((column) => ({ header: str(column.header), accessor: str(column.accessor) }));
}

function tableRows(value: unknown): string[][] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(Array.isArray)
    .map((row) =>
      row.map((cell: unknown) => (typeof cell === 'string' ? cell : String(cell ?? ''))),
    );
}

function tableFooter(value: unknown): TableProps['footer'] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((cell) => ({
    content: str(cell.content),
    colSpan: typeof cell.colSpan === 'number' ? cell.colSpan : undefined,
  }));
}

export const TableSurface: FC<A2uiNodeViewProps> = ({ node }) => (
  <TableRoot
    argumentsProps={{
      title: optStr(node.props.title),
      description: optStr(node.props.description),
      caption: optStr(node.props.caption),
      columns: tableColumns(node.props.columns),
      rows: tableRows(node.props.rows),
      footer: tableFooter(node.props.footer),
    }}
  />
);
